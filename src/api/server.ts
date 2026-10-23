import Fastify from 'fastify'
import { redisClient, bootRedis } from '../config/redis.js'
import { pool } from '../config/db.js'
import { schemaProblem } from '../db/migrate.js'
import { coarseHealth, mapSignalRow, signalsQuery } from './publicData.js'
import { startSseHeartbeat } from './sseHeartbeat.js'
import { loadHolidays } from '../core/sessionGuard.js'
import { getISTDateString } from '../utils/marketHours.js'

const fastify = Fastify({ logger: true })

// Enable CORS
fastify.register(import('@fastify/cors'), {
	origin: '*', // Adjust this for production security
})

// Pub/Sub duplicate for SSE
const subscriber = redisClient.duplicate()
subscriber.on('error', (err) => console.error('[Redis SSE] Subscriber Error:', err))

const clients = new Set<any>()
const livePnlCache: Record<string, any> = {}

// Connect Subscriber
const bootSubscriber = async () => {
	await subscriber.connect()
	await subscriber.subscribe('sse:events', (message) => {
		let parsed: any = null;
		try {
			parsed = JSON.parse(message)
			if (parsed.type === 'pnl_update') {
				livePnlCache[parsed.data.symbol] = parsed.data.unrealizedPnl
			} else if (parsed.type === 'signal_event' && (parsed.data.status === 'CLOSED' || parsed.data.exitPrice)) {
				delete livePnlCache[parsed.data.symbol]
			}
		} catch(e) {}

		for (const client of clients) {
			try {
				if (parsed && parsed.type === 'signal_event') {
					if (!client.includeUngated && parsed.data.gated === false) {
						continue; // Skip sending this event to this client
					}
				}
				client.reply.raw.write(`data: ${message}\n\n`)
			} catch(e) {}
		}
	})
	console.log('🟢 [API Server] Subscribed to sse:events channel')
}

// REST: Get Today's Status (Fetch-on-mount for Dashboard)
fastify.get('/api/today', async (request, reply) => {
	const query = request.query as any
	const includeUngated = query.includeUngated === 'true'

	let sql = `SELECT * FROM paper_trades WHERE status = 'OPEN'`
	if (!includeUngated) {
		sql += ` AND gated = true`
	}
	sql += ` ORDER BY entry_time DESC`

	const openRes = await pool.query(sql)
	
	const pnlStr = await redisClient.get('pnl:daily')
	
	return {
		success: true,
		realizedPnl: Number(pnlStr || 0),
		openTrades: openRes.rows.map(r => ({
			id: r.id,
			symbol: r.symbol,
			side: r.direction,
			entryPrice: Number(r.entry_price),
			timestamp: new Date(r.entry_time).getTime(),
			target: Number(r.target_price),
			stopLoss: Number(r.stop_price),
			detectorName: r.detector,
			size: Number(r.qty) || 100,
			capitalGated: r.capital_gated || false,
			actualSize: r.actual_size !== null ? Number(r.actual_size) : (Number(r.qty) || 100),
			durationClass: r.duration_class || 'INTRADAY',
			// Read-only additions for the dashboard redesign (2026-10-23): the alert flag, the
			// declared regime and the row's data-quality flags (duplicate / invalid rows visible).
			gated: r.gated === true,
			regimeClass: r.regime_class ?? undefined,
			dataQuality: Array.isArray(r.data_quality) ? r.data_quality : [],
		}))
	}
})

// REST: Get Historical Trades (With Date and Detector Filtering)
fastify.get('/api/trades/history', async (request, reply) => {
	const query = request.query as any
	const date = query.date // format YYYY-MM-DD
	const detector = query.detector
	const includeUngated = query.includeUngated === 'true'

	// By default, only show signals that passed the JaneStreetFilter (gated = true).
	let sql = `SELECT * FROM paper_trades WHERE status = 'CLOSED'`
	if (!includeUngated) {
		sql += ` AND gated = true`
	}
	
	const params: any[] = []
	
	if (date) {
		params.push(date)
		sql += ` AND exit_time::date = $${params.length}`
	}
	
	if (detector) {
		params.push(detector)
		sql += ` AND detector = $${params.length}`
	}
	
	sql += ` ORDER BY exit_time DESC LIMIT 200`
	
	const res = await pool.query(sql, params)
	
	return {
		success: true,
		count: res.rowCount,
		data: res.rows.map(r => ({
			id: r.id,
			symbol: r.symbol,
			side: r.direction,
			entryPrice: Number(r.entry_price),
			exitPrice: Number(r.exit_price),
			pnl: Number(r.realized_pnl),
			timestamp: new Date(r.entry_time).getTime(),
			exitTimestamp: r.exit_time ? new Date(r.exit_time).getTime() : null,
			detectorName: r.detector,
			regimeClass: r.regime_class,
			gated: r.gated,
			size: Number(r.qty) || 100,
			r_multiple: r.r_multiple ? Number(r.r_multiple) : undefined,
			capitalGated: r.capital_gated || false,
			actualSize: r.actual_size !== null ? Number(r.actual_size) : (Number(r.qty) || 100),
			durationClass: r.duration_class || 'INTRADAY',
			exitReason: r.exit_reason || undefined,
			// Read-only additions (2026-10-23): the recorded levels, so the trade view never has to
			// invent them, and the data-quality flags.
			target: r.target_price !== null && r.target_price !== undefined ? Number(r.target_price) : undefined,
			stopLoss: r.stop_price !== null && r.stop_price !== undefined ? Number(r.stop_price) : undefined,
			dataQuality: Array.isArray(r.data_quality) ? r.data_quality : [],
		}))
	}
})

// REST: Get Live PnL (for Polling Fallback)
fastify.get('/api/live-pnl', async (request, reply) => {
	return { success: true, data: livePnlCache }
})

// REST: Get Heatmap Data (Daily signal counts)
fastify.get('/api/trades/heatmap', async (request, reply) => {
	const sql = `
		SELECT 
			exit_time::date as date, 
			COUNT(*) as count
		FROM paper_trades 
		WHERE status = 'CLOSED'
		GROUP BY exit_time::date
		ORDER BY exit_time::date DESC
		LIMIT 100
	`
	const res = await pool.query(sql)
	
	return {
		success: true,
		data: res.rows.map(r => ({
			date: r.date,
			count: Number(r.count)
		}))
	}
})

// REST: every fire of a day from the signals table — read-only (src/api/publicData.ts)
fastify.get('/api/signals', async (request, reply) => {
	const date = String((request.query as any)?.date ?? getISTDateString())
	const q = signalsQuery(date)
	if (!q) return reply.code(400).send({ success: false, error: 'date must be YYYY-MM-DD' })
	const res = await pool.query(q.sql, q.params)
	return { success: true, date, count: res.rowCount, data: res.rows.map(mapSignalRow) }
})

// REST: coarse public health — status, ticks per 5 min, stocks seen; nothing else (owner, 2026-10-23)
const HOLIDAYS = loadHolidays()
fastify.get('/api/health', async () => {
	const now = Date.now()
	const today = getISTDateString(now)
	const last = await redisClient.lRange('ema_shadow:nifty:bars5', -1, -1)
	let lastBarStartMs: number | null = null
	try {
		lastBarStartMs = last[0] ? Number(JSON.parse(last[0]).t) || null : null
	} catch {
		lastBarStartMs = null
	}
	let stocksSeenToday = 0
	for await (const batch of redisClient.scanIterator({ MATCH: `vwap:*:${today}`, COUNT: 500 }))
		stocksSeenToday += batch.filter((k) => !k.includes('-INDEX:')).length
	return { success: true, data: coarseHealth({ nowMs: now, holidays: HOLIDAYS, lastBarStartMs, stocksSeenToday }) }
})

// SSE Stream Endpoint
fastify.get('/api/events', (request, reply) => {
	const query = request.query as any
	const includeUngated = query.includeUngated === 'true'

	reply.raw.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'Access-Control-Allow-Origin': '*'
	})

	reply.raw.write('retry: 3000\n\n')
	// keep-alive comment every 25 s so an idle-timeout proxy (the Vercel /api rewrite) keeps the stream open
	const stopHeartbeat = startSseHeartbeat((chunk) => reply.raw.write(chunk))

	const clientObj = { reply, includeUngated }
	clients.add(clientObj)
	console.log(`[SSE] Client connected. Active clients: ${clients.size} (includeUngated: ${includeUngated})`)

	request.raw.on('close', () => {
		stopHeartbeat()
		clients.delete(clientObj)
		console.log(`[SSE] Client disconnected. Active clients: ${clients.size}`)
	})
})

const startServer = async () => {
	await bootRedis()
	await bootSubscriber()

	// ── Schema check (read-only) ──
	// Migrations are versioned and run explicitly with `npm run migrate`
	// (src/db/migrate.ts). This boot path never mutates the database, so
	// restarting quant_api is safe. It only warns when the schema is behind.
	const schemaIssue = await schemaProblem(pool)
	if (schemaIssue) {
		console.warn(`[API Server] ⚠️  Database schema not current: ${schemaIssue}`)
	} else {
		console.log('[API Server] ✅ Database schema is current.')
	}

	try {
		const port = 8080
		await fastify.listen({ port, host: '0.0.0.0' })
		console.log(`[API Server] 📡 Listening on http://0.0.0.0:${port}`)
	} catch (err) {
		fastify.log.error(err)
		process.exit(1)
	}
}

startServer()

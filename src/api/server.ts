import Fastify from 'fastify'
import { redisClient, bootRedis } from '../config/redis.js'
import { pool } from '../config/db.js'
import { schemaProblem } from '../db/migrate.js'

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

// A second fire on the same symbol + side (owner, 2026-10-22) is recorded but flagged
// duplicate_signal: the same trade counted twice. Excluded from every stat unless
// ?includeDuplicates=true.
const NOT_DUPLICATE = ` AND NOT ('duplicate_signal' = ANY(COALESCE(data_quality, '{}')))`

// REST: Get Today's Status (Fetch-on-mount for Dashboard)
fastify.get('/api/today', async (request, reply) => {
	const query = request.query as any
	const includeUngated = query.includeUngated === 'true'

	let sql = `SELECT * FROM paper_trades WHERE status = 'OPEN'`
	if (!includeUngated) {
		sql += ` AND gated = true`
	}
	if (query.includeDuplicates !== 'true') sql += NOT_DUPLICATE
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
	if (query.includeDuplicates !== 'true') sql += NOT_DUPLICATE
	
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
		WHERE status = 'CLOSED'${NOT_DUPLICATE}
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

	const clientObj = { reply, includeUngated }
	clients.add(clientObj)
	console.log(`[SSE] Client connected. Active clients: ${clients.size} (includeUngated: ${includeUngated})`)

	request.raw.on('close', () => {
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

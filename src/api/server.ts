import Fastify from 'fastify'
import { redisClient, bootRedis } from '../config/redis.js'
import { pool } from '../config/db.js'

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
		try {
			const parsed = JSON.parse(message)
			if (parsed.type === 'pnl_update') {
				livePnlCache[parsed.data.symbol] = parsed.data.unrealizedPnl
			} else if (parsed.type === 'signal_event' && (parsed.data.status === 'CLOSED' || parsed.data.exitPrice)) {
				delete livePnlCache[parsed.data.symbol]
			}
		} catch(e) {}

		for (const client of clients) {
			client.raw.write(`data: ${message}

`)
		}
	})
	console.log('🟢 [API Server] Subscribed to sse:events channel')
}

// REST: Get Today's Status (Fetch-on-mount for Dashboard)
fastify.get('/api/today', async (request, reply) => {
	const openRes = await pool.query(`
		SELECT * FROM paper_trades 
		WHERE status = 'OPEN' 
		ORDER BY entry_time DESC
	`)
	
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

	let sql = `SELECT * FROM paper_trades WHERE status = 'CLOSED'`
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

// SSE Stream Endpoint
fastify.get('/api/events', (request, reply) => {
	reply.raw.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'Access-Control-Allow-Origin': '*'
	})

	reply.raw.write('retry: 3000\n\n')

	clients.add(reply)
	console.log(`[SSE] Client connected. Active clients: ${clients.size}`)

	request.raw.on('close', () => {
		clients.delete(reply)
		console.log(`[SSE] Client disconnected. Active clients: ${clients.size}`)
	})
})

const startServer = async () => {
	await bootRedis()
	await bootSubscriber()

	// ── Auto-Migration & Schema Updates ──
	try {
		console.log('[API Server] 🔄 Checking and backfilling paper_trades schema...')

		// Column additions (idempotent)
		await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS r_multiple NUMERIC(10,2)`)
		await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS qty NUMERIC(10,2)`)
		await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS capital_gated BOOLEAN DEFAULT FALSE`)
		await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS actual_size NUMERIC(10,2)`)
		await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS duration_class TEXT`)
		await pool.query(`ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_reason TEXT`)

		// Indexes (idempotent via IF NOT EXISTS)
		await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON paper_trades (entry_time)`)
		await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_exit_time  ON paper_trades (exit_time DESC)`)
		await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_status     ON paper_trades (status)`)
		await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_symbol     ON paper_trades (symbol)`)
		await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_open       ON paper_trades (entry_time DESC) WHERE status = 'OPEN'`)

		// Backfill qty and r_multiple for pre-sizing-era trades
		const backfillRes = await pool.query(`
			UPDATE paper_trades
			SET 
				qty = CASE 
					WHEN stop_price IS NOT NULL AND stop_price != entry_price THEN 
						LEAST(
							GREATEST(1, FLOOR(10000.0 / entry_price)),
							GREATEST(1, FLOOR(1000.0 / ABS(entry_price - stop_price)))
						)
					ELSE 100 
				END,
				r_multiple = CASE 
					WHEN exit_price IS NOT NULL AND stop_price IS NOT NULL AND stop_price != entry_price THEN
						CASE 
							WHEN direction = 'LONG' THEN (exit_price - entry_price) / (entry_price - stop_price)
							WHEN direction = 'SHORT' THEN (entry_price - exit_price) / (stop_price - entry_price)
						END
					ELSE NULL
				END
			WHERE r_multiple IS NULL OR qty IS NULL OR qty = 0;
		`)

		await pool.query(`UPDATE paper_trades SET actual_size = qty WHERE actual_size IS NULL;`)

		// Backfill duration_class for existing trades based on known detector names
		await pool.query(`
			UPDATE paper_trades 
			SET duration_class = CASE
				WHEN detector ILIKE '%Momentum%' OR detector ILIKE '%VCP%' OR detector ILIKE '%Volatility_Contraction%' THEN 'SWING'
				ELSE 'INTRADAY'
			END
			WHERE duration_class IS NULL
		`)

		// Backfill PnL using actual_size
		const pnlRes = await pool.query(`
			UPDATE paper_trades
			SET realized_pnl = CASE
				WHEN exit_price IS NOT NULL AND direction = 'LONG' THEN (exit_price - entry_price) * actual_size
				WHEN exit_price IS NOT NULL AND direction = 'SHORT' THEN (entry_price - exit_price) * actual_size
				ELSE realized_pnl
			END
			WHERE exit_price IS NOT NULL;
		`)

		// Mark stale OPEN trades (opened on a prior day) as expired breakeven closes
		// so they don't dangle in Postgres forever with NULL exit columns.
		// These were positions the engine held overnight but the exit condition
		// was never met and the engine stopped (15:30 shutdown) before closing them.
		const staleRes = await pool.query(`
			UPDATE paper_trades
			SET 
				status = 'CLOSED',
				exit_price = entry_price,
				exit_time = now(),
				realized_pnl = 0,
				exit_reason = 'EOD_EXPIRED',
				r_multiple = 0
			WHERE status = 'OPEN' AND entry_time::date < CURRENT_DATE
		`)

		console.log(`[API Server] ✅ Migration complete. Backfilled ${backfillRes.rowCount} R/size, adjusted PnL for ${pnlRes.rowCount} trades, expired ${staleRes.rowCount} stale OPEN rows.`)
	} catch (err) {
		console.error('[API Server] ❌ Migration failed:', err)
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

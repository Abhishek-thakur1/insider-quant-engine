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

// Connect Subscriber
const bootSubscriber = async () => {
	await subscriber.connect()
	await subscriber.subscribe('sse:events', (message) => {
		for (const client of clients) {
			client.raw.write(`data: ${message}\n\n`)
		}
	})
	console.log('🟢 [API Server] Subscribed to sse:events channel')
}

// REST: Get Today's Status (Fetch-on-mount for Dashboard)
fastify.get('/api/today', async (request, reply) => {
	const openRes = await pool.query(`
		SELECT * FROM paper_trades 
		WHERE status = 'OPEN' 
		AND entry_time >= current_date
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
			detectorName: r.detector
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
		sql += ` AND entry_time::date = $${params.length}`
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
			exitTimestamp: new Date(r.exit_time).getTime(),
			detectorName: r.detector,
			regimeClass: r.regime_class,
			gated: r.gated
		}))
	}
})

// SSE Stream Endpoint
fastify.get('/api/stream', (request, reply) => {
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

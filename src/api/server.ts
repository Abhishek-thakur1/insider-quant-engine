import Fastify from 'fastify'
import { redisClient, bootRedis } from '../config/redis.js'
import { ENV } from '../config/env.js'

const fastify = Fastify({ logger: true })

// Enable CORS if you run dashboard on a different port locally
fastify.register(import('@fastify/cors'), {
	origin: '*',
})

// Route: Get Open Trades
fastify.get('/api/trades/open', async (request, reply) => {
	const keys = await redisClient.hKeys('trades:open')
	const trades = []
	for (const key of keys) {
		const data = await redisClient.hGet('trades:open', key)
		if (data) trades.push(JSON.parse(data))
	}
	// Sort by newest first
	trades.sort((a, b) => b.timestamp - a.timestamp)
	return { success: true, count: trades.length, data: trades }
})

// Route: Get Closed Trades History
fastify.get('/api/trades/history', async (request, reply) => {
	const limit = (request.query as any).limit || 50
	const data = await redisClient.lRange('trades:history', 0, limit - 1)
	const trades = data.map((t) => JSON.parse(t))
	return { success: true, count: trades.length, data: trades }
})

// Route: Get Daily PnL
fastify.get('/api/pnl/daily', async (request, reply) => {
	const pnlStr = await redisClient.get('pnl:daily')
	return { success: true, pnl: Number(pnlStr || 0) }
})

// Start the API Server
const startServer = async () => {
	await bootRedis()

	try {
		// Use port 8080 or process.env.API_PORT
		const port = 8080
		await fastify.listen({ port, host: '0.0.0.0' })
		console.log(`[API Server] 📡 Listening on http://0.0.0.0:${port}`)
	} catch (err) {
		fastify.log.error(err)
		process.exit(1)
	}
}

startServer()

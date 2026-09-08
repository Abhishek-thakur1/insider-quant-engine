import { redisClient } from '../config/redis.js'
import type { TickData } from './types.js'

export interface OpenPosition {
	id: string
	symbol: string
	side: 'LONG' | 'SHORT'
	entryPrice: number
	stopLoss: number
	target: number
	timestamp: number
	detectorName: string
	size: number
}

export interface ClosedPosition extends OpenPosition {
	exitPrice: number
	exitTimestamp: number
	pnl: number
	exitReason: 'STOP_LOSS' | 'TARGET'
}

class PositionTracker {
	private openPositions = new Map<string, OpenPosition[]>()
	private isInitialized = false

	// Load open positions from Redis on boot
	public async init() {
		if (this.isInitialized) return
		try {
			const keys = await redisClient.hKeys('trades:open')
			for (const key of keys) {
				const data = await redisClient.hGet('trades:open', key)
				if (data) {
					const pos = JSON.parse(data) as OpenPosition
					this.addToMemory(pos)
				}
			}
			console.log(`[PositionTracker] 🔄 Loaded ${keys.length} open positions from Redis.`)
			this.isInitialized = true
		} catch (err) {
			console.error('[PositionTracker] ❌ Init error:', err)
		}
	}

	private addToMemory(pos: OpenPosition) {
		const existing = this.openPositions.get(pos.symbol) || []
		existing.push(pos)
		this.openPositions.set(pos.symbol, existing)
	}

	public async registerTrade(pos: OpenPosition) {
		// Save to Redis for persistence and API access
		await redisClient.hSet('trades:open', pos.id, JSON.stringify(pos))
		// Track in memory for ultra-fast tick checking
		this.addToMemory(pos)
		console.log(`[PositionTracker] 📝 Registered new ${pos.side} position for ${pos.symbol} at ₹${pos.entryPrice}`)
	}

	public async processTick(symbol: string, tick: TickData) {
		const positions = this.openPositions.get(symbol)
		if (!positions || positions.length === 0) return

		const ltp = tick.price
		const remaining: OpenPosition[] = []

		for (const pos of positions) {
			let isClosed = false
			let exitReason: 'STOP_LOSS' | 'TARGET' | null = null

			if (pos.side === 'LONG') {
				if (ltp <= pos.stopLoss) {
					isClosed = true
					exitReason = 'STOP_LOSS'
				} else if (ltp >= pos.target) {
					isClosed = true
					exitReason = 'TARGET'
				}
			} else { // SHORT
				if (ltp >= pos.stopLoss) {
					isClosed = true
					exitReason = 'STOP_LOSS'
				} else if (ltp <= pos.target) {
					isClosed = true
					exitReason = 'TARGET'
				}
			}

			if (isClosed && exitReason) {
				const pnl = pos.side === 'LONG' 
					? (ltp - pos.entryPrice) * pos.size 
					: (pos.entryPrice - ltp) * pos.size

				const closedPos: ClosedPosition = {
					...pos,
					exitPrice: ltp,
					exitTimestamp: tick.timestamp,
					pnl: Number(pnl.toFixed(2)),
					exitReason
				}

				// Atomic Redis operations: remove from open, push to history
				const pipeline = redisClient.multi()
				pipeline.hDel('trades:open', pos.id)
				pipeline.lPush('trades:history', JSON.stringify(closedPos))
				// Update daily PnL counter
				pipeline.incrByFloat('pnl:daily', closedPos.pnl)
				await pipeline.exec()

				console.log(`[PositionTracker] 🏁 Closed ${pos.symbol} | Reason: ${exitReason} | PnL: ₹${closedPos.pnl}`)
			} else {
				remaining.push(pos)
			}
		}

		if (remaining.length !== positions.length) {
			if (remaining.length === 0) {
				this.openPositions.delete(symbol)
			} else {
				this.openPositions.set(symbol, remaining)
			}
		}
	}
}

export const positionTracker = new PositionTracker()

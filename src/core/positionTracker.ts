import { redisClient } from '../config/redis.js'
import { pool } from '../config/db.js'
import type { TickData } from './types.js'
import { insertStatusFor, isOrphanedAtBoot, istDate } from './positionStatus.js'

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
	regimeClass?: string
	gated?: boolean
	capitalGated?: boolean
	actualSize?: number
	durationClass?: 'INTRADAY' | 'SWING'
	/** Extra provenance flags for the paper row (e.g. invalid_geometry from the alert pipeline). */
	dataQuality?: string[]
}

export interface ClosedPosition extends OpenPosition {
	exitPrice: number
	exitTimestamp: number
	pnl: number
	exitReason: 'STOP_LOSS' | 'TARGET' | 'TIME'
}

class PositionTracker {
	private openPositions = new Map<string, OpenPosition[]>()
	private lastPnlPublishTime = new Map<string, number>()
	private isInitialized = false

	// Load open positions from Redis on boot. trades:open is NOT cleared at boot
	// (websocket.ts), so SWING positions carry over between sessions. INTRADAY
	// leftovers from a prior day are marked ORPHANED instead of being closed at
	// today's price.
	public async init() {
		if (this.isInitialized) return
		try {
			const keys = await redisClient.hKeys('trades:open')
			let loaded = 0
			let orphaned = 0
			for (const key of keys) {
				const data = await redisClient.hGet('trades:open', key)
				if (!data) continue
				const pos = JSON.parse(data) as OpenPosition
				if (isOrphanedAtBoot(pos, Date.now())) {
					await this.markOrphaned(pos)
					orphaned++
					continue
				}
				this.addToMemory(pos)
				loaded++
			}
			console.log(`[PositionTracker] 🔄 Loaded ${loaded} open positions from Redis (${orphaned} prior-day INTRADAY marked ORPHANED).`)
			this.isInitialized = true
		} catch (err) {
			console.error('[PositionTracker] ❌ Init error:', err)
		}
	}

	private async markOrphaned(pos: OpenPosition) {
		try {
			await pool.query(
				`UPDATE paper_trades
				 SET status = 'ORPHANED',
				     data_quality = CASE WHEN 'orphaned' = ANY(data_quality) THEN data_quality ELSE array_append(data_quality, 'orphaned') END
				 WHERE symbol = $1 AND status IN ('OPEN', 'SKIPPED') AND entry_time = to_timestamp($2 / 1000.0)`,
				[pos.symbol, pos.timestamp],
			)
			await redisClient.hDel('trades:open', pos.id)
			console.warn(`[PositionTracker] 👻 ${pos.symbol} ${pos.side} from ${istDate(pos.timestamp)} was never closed — marked ORPHANED (no exit recorded).`)
		} catch (err) {
			// Leave it in Redis so the next boot retries; don't track it in memory.
			console.error(`[PositionTracker] ❌ Failed to mark ${pos.symbol} ORPHANED:`, err)
		}
	}

	private addToMemory(pos: OpenPosition) {
		const existing = this.openPositions.get(pos.symbol) || []
		existing.push(pos)
		this.openPositions.set(pos.symbol, existing)
	}

	public getOpenPositions(): OpenPosition[] {
		return Array.from(this.openPositions.values()).flat()
	}

	public getCurrentNotional(): number {
		return this.getOpenPositions().reduce((sum, pos) => sum + (pos.entryPrice * (pos.actualSize ?? pos.size)), 0)
	}

	// Returns the paper_trades.id of the inserted row (null if the insert failed),
	// so the signals log can link the signal to its trade.
	public async registerTrade(pos: OpenPosition): Promise<number | null> {
		// Save to Redis for persistence and API access
		await redisClient.hSet('trades:open', pos.id, JSON.stringify(pos))
		// Track in memory for ultra-fast tick checking
		this.addToMemory(pos)

		// Insert into Postgres. Capital-skipped signals (actual size 0) go in as
		// SKIPPED, not OPEN — they are not positions (see positionStatus.ts).
		const { status, dataQuality: statusFlags } = insertStatusFor(pos)
		const dataQuality = [...statusFlags, ...(pos.dataQuality ?? [])]
		let tradeId: number | null = null
		try {
			const ins = await pool.query(
				`INSERT INTO paper_trades (
					symbol, detector, direction, entry_price, entry_time, stop_price, target_price, status, regime_class, gated, qty, capital_gated, actual_size, duration_class, data_quality
				) VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7, $14, $8, $9, $10, $11, $12, $13, $15)
				RETURNING id`,
				[pos.symbol, pos.detectorName, pos.side, pos.entryPrice, pos.timestamp, pos.stopLoss, pos.target, pos.regimeClass || null, pos.gated || false, pos.size, pos.capitalGated || false, pos.actualSize ?? pos.size, pos.durationClass || 'INTRADAY', status, dataQuality]
			)
			tradeId = (ins.rows[0]?.id as number | undefined) ?? null
		} catch (dbErr) {
			console.error('[PositionTracker] ❌ Postgres insert error:', dbErr)
		}

		// Publish signal_event for open
		redisClient.publish('sse:events', JSON.stringify({
			type: 'signal_event',
			data: pos
		})).catch(() => {})

		console.log(`[PositionTracker] 📝 Registered new ${pos.side} position for ${pos.symbol} at ₹${pos.entryPrice}`)
		return tradeId
	}

	public async processTick(symbol: string, tick: TickData) {
		const positions = this.openPositions.get(symbol)
		if (!positions || positions.length === 0) return

		const ltp = tick.price
		const remaining: OpenPosition[] = []

		const nowIST = new Date(Date.now() + 5.5 * 3600 * 1000)
		const m = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes()
		const isAfter315 = m >= 15 * 60 + 15

		for (const pos of positions) {
			let isClosed = false
			let exitReason: 'STOP_LOSS' | 'TARGET' | 'TIME' | null = null

			// Force close INTRADAY positions at or after 3:15 PM. Prior-day INTRADAY
			// leftovers never reach here: init() marks them ORPHANED instead of
			// closing them at the next session's price.
			if (isAfter315 && (!pos.durationClass || pos.durationClass === 'INTRADAY')) {
				isClosed = true
				exitReason = 'TIME'
			} else if (pos.side === 'LONG') {
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
				const executedSize = pos.actualSize ?? pos.size;
				const pnl = pos.side === 'LONG'
					? (ltp - pos.entryPrice) * executedSize
					: (pos.entryPrice - ltp) * executedSize

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
				// Update daily PnL counter — a duplicate_signal row is the same trade counted
				// twice (owner, 2026-10-22), so it stays out of the daily P&L.
				if (!pos.dataQuality?.includes('duplicate_signal')) pipeline.incrByFloat('pnl:daily', closedPos.pnl)
				await pipeline.exec()

				// Update Postgres
				try {
					// Guard against division by zero: if SL === entry, r_multiple is undefined
					const denominator = pos.side === 'LONG'
						? (pos.entryPrice - pos.stopLoss)
						: (pos.stopLoss - pos.entryPrice)
					const r_multiple_raw = denominator !== 0
						? (pos.side === 'LONG'
							? (closedPos.exitPrice - pos.entryPrice) / denominator
							: (pos.entryPrice - closedPos.exitPrice) / denominator)
						: null
					// Clamp: discard Infinity/NaN which crash Postgres NUMERIC(10,2)
					const r_multiple = r_multiple_raw !== null && isFinite(r_multiple_raw)
						? Number(r_multiple_raw.toFixed(4))
						: null

					await pool.query(
						`UPDATE paper_trades 
						 SET exit_price = $1, exit_time = to_timestamp($2 / 1000.0), realized_pnl = $3, r_multiple = $4, exit_reason = $5,
						     status = CASE WHEN status = 'SKIPPED' THEN 'SKIPPED' ELSE 'CLOSED' END
						 WHERE symbol = $6 AND status IN ('OPEN', 'SKIPPED') AND entry_time = to_timestamp($7 / 1000.0)`,
						[closedPos.exitPrice, closedPos.exitTimestamp, closedPos.pnl, r_multiple, exitReason, pos.symbol, pos.timestamp]
					)
				} catch (dbErr) {
					console.error('[PositionTracker] ❌ Postgres update error:', dbErr)
				}

				console.log(`[PositionTracker] 🏁 Closed ${pos.symbol} | Reason: ${exitReason} | PnL: ₹${closedPos.pnl}`)
				// Publish signal_event for close
				redisClient.publish('sse:events', JSON.stringify({
					type: 'signal_event',
					data: closedPos
				})).catch(() => {})
			} else {
				remaining.push(pos)

				// Throttle PnL updates to 1 per second per symbol
				const now = Date.now()
				if (now - this.lastPnlPublishTime.get(symbol)! > 1000 || !this.lastPnlPublishTime.has(symbol)) {
					// Use actualSize (real executed qty) not size (unconstrained qty)
					const executedSize = pos.actualSize ?? pos.size
					const unrealizedPnl = pos.side === 'LONG'
						? (ltp - pos.entryPrice) * executedSize
						: (pos.entryPrice - ltp) * executedSize

					redisClient.publish('sse:events', JSON.stringify({
						type: 'pnl_update',
						data: { symbol: pos.symbol, currentPrice: ltp, unrealizedPnl, timestamp: tick.timestamp }
					})).catch(() => {})

					this.lastPnlPublishTime.set(symbol, now)
				}
			}
		}

		if (remaining.length !== positions.length) {
			if (remaining.length === 0) {
				this.openPositions.delete(symbol)
				this.lastPnlPublishTime.delete(symbol)
			} else {
				this.openPositions.set(symbol, remaining)
			}
		}
	}
}

export const positionTracker = new PositionTracker()

import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap } from '../utils/vwapUtils.js'
import { getBestStrike, getWallStrikes } from '../utils/optionUtils.js'

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_DURATION_MS = 3 * 60 * 1000 // 3-minute candles
const PIERCE_BUFFER_PTS = 15 // Spot must push 15 pts past the strike to trap retail
const COOLDOWN_SECONDS = 3600 // Only trade this once per hour max

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

const isActiveWindow = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 45 && m <= 15 * 60 // Let morning OI settle before trading
}

interface Candle {
	open: number
	high: number
	low: number
	close: number
	startTs: number
}

export class OiLiquiditySweepDetector implements IDetector {
	public name = 'Institutional OI Liquidity Sweep'
	public symbol = 'NSE:NIFTY50-INDEX'

	private currentCandle: Candle | null = null

	// State Machine
	private state: 'WAITING' | 'PIERCED_RESISTANCE' | 'PIERCED_SUPPORT' = 'WAITING'
	private activeTrapStrike: number | null = null

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isActiveWindow() || this.symbol !== 'NSE:NIFTY50-INDEX') return

		const now = liveTick.timestamp

		// ── 1. Build 3-min Candle ──
		if (!this.currentCandle) {
			this.currentCandle = {
				open: liveTick.price,
				high: liveTick.price,
				low: liveTick.price,
				close: liveTick.price,
				startTs: now,
			}
			return
		}

		if (now - this.currentCandle.startTs < CANDLE_DURATION_MS) {
			this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
			this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
			this.currentCandle.close = liveTick.price

			// Intraday continuous state evaluation (don't wait for candle close to arm the trap)
			this.evaluateLiveTrap(liveTick.price)
			return
		}

		// ── 2. Candle Closed: Evaluate Reversal ──
		const c = { ...this.currentCandle }
		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			startTs: now,
		}

		const cooldownKey = `cooldown:oi_sweep`
		if (await redisClient.get(cooldownKey)) return

		// ── SHORT: Resistance Sweep Failed ──
		// Spot pierced the Call Wall, trapped retail, and closed back below the wall.
		if (this.state === 'PIERCED_RESISTANCE' && this.activeTrapStrike) {
			if (c.close < this.activeTrapStrike) {
				await this.executeSignal('SHORT', c, this.activeTrapStrike, cooldownKey)
			} else if (c.close > this.activeTrapStrike + PIERCE_BUFFER_PTS * 2) {
				// Real breakout, invalidate the trap
				this.resetState()
			}
		}

		// ── LONG: Support Sweep Failed ──
		// Spot pierced the Put Wall, trapped retail, and closed back above the wall.
		if (this.state === 'PIERCED_SUPPORT' && this.activeTrapStrike) {
			if (c.close > this.activeTrapStrike) {
				await this.executeSignal('LONG', c, this.activeTrapStrike, cooldownKey)
			} else if (c.close < this.activeTrapStrike - PIERCE_BUFFER_PTS * 2) {
				// Real breakdown, invalidate the trap
				this.resetState()
			}
		}
	}

	private evaluateLiveTrap(currentPrice: number) {
		if (this.state !== 'WAITING') return

		// Fetch the active walls from optionUtils
		const { maxCallStrike, maxPutStrike } = getWallStrikes()

		if (maxCallStrike && currentPrice >= maxCallStrike + PIERCE_BUFFER_PTS) {
			console.log(`[OI Trap] 🪤 Nifty pierced Call Wall at ${maxCallStrike}. Arming Bear Trap.`)
			this.state = 'PIERCED_RESISTANCE'
			this.activeTrapStrike = maxCallStrike
		}

		if (maxPutStrike && currentPrice <= maxPutStrike - PIERCE_BUFFER_PTS) {
			console.log(`[OI Trap] 🪤 Nifty pierced Put Wall at ${maxPutStrike}. Arming Bull Trap.`)
			this.state = 'PIERCED_SUPPORT'
			this.activeTrapStrike = maxPutStrike
		}
	}

	private async executeSignal(
		side: 'LONG' | 'SHORT',
		candle: Candle,
		wallStrike: number,
		cooldownKey: string,
	) {
		const vwap = (await getVwap(this.symbol)) || candle.close
		const bestStrike = getBestStrike(side === 'LONG' ? 'CE' : 'PE', candle.close)

		const stopLoss = side === 'LONG' ? candle.low - 5 : candle.high + 5
		const risk = Math.abs(candle.close - stopLoss)

		// Skip if candle was a massive anomaly
		if (risk > 40) {
			this.resetState()
			return
		}

		const t1 = side === 'LONG' ? candle.close + risk * 2 : candle.close - risk * 2

		console.log(`\n🎯 [INSTITUTIONAL OI SWEEP ${side}] Trap sprung at ${wallStrike}`)

		sendTelegramAlert({
			symbol: `NIFTY ${bestStrike.strike} ${side === 'LONG' ? 'CE' : 'PE'}`,
			price: candle.close,
			side: side,
			percentageChange: 0,
			volumeSpikeRatio: 1,
			trigger: `🪤 ${side === 'LONG' ? 'Bear Trap' : 'Bull Trap'} at ${wallStrike} OI Wall | Spot ${candle.close} | SL ₹${stopLoss} | T1 ₹${t1} | ${bestStrike.reason}`,
			vwap: vwap,
			avgPrice: candle.close,
		})

		await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
		this.resetState()
	}

	private resetState() {
		this.state = 'WAITING'
		this.activeTrapStrike = null
	}
}

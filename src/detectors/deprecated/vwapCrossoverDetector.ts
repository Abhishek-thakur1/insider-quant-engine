import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap } from '../../utils/vwapUtils.js'
import { getBestStrike } from '../../utils/optionUtils.js'

const CANDLE_DURATION_MS = 60 * 1000 // 1-minute candles for sniper entries
const MEMORY_LENGTH = 3 // Just need previous candle context
const COOLDOWN_SECONDS = 900 // 15 min cooldown
const MIN_BODY_POINTS = 8 // Requires a strong, decisive 8+ point crossover candle

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const isActiveWindow = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 25 && m <= 15 * 60 // Active almost all day
}

interface Candle {
	open: number
	high: number
	low: number
	close: number
	startTs: number
}

export class VwapCrossoverDetector implements IDetector {
	public name = 'Nifty VWAP Crossover Sniper'
	public symbol = 'NSE:NIFTY50-INDEX'

	private currentCandle: Candle | null = null
	private history: Candle[] = []

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isActiveWindow() || this.symbol !== 'NSE:NIFTY50-INDEX') return

		const now = liveTick.timestamp

		// ── Build 1-min candle ───────────────────────────────────────────
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
			return
		}

		// ── Candle Closed ────────────────────────────────────────────────
		const c = { ...this.currentCandle }
		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			startTs: now,
		}

		this.history.push(c)
		if (this.history.length > MEMORY_LENGTH) this.history.shift()

		if (this.history.length < 2) return

		const cooldownKey = `cooldown:nifty_vwap_crossover`
		if (await redisClient.get(cooldownKey)) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		const priorCandle = this.history[this.history.length - 2]!
		const bodySize = Math.abs(c.close - c.open)
		const isRealBody = bodySize >= MIN_BODY_POINTS

		// ── LONG SCALP: Bear-to-Bull Crossover (V-Shape Recovery) ──────────
		// 1. Previous candle closed BELOW VWAP
		// 2. Current candle blasted through and closed ABOVE VWAP
		// 3. Current candle is a strong green body (not a doji)

		const wasBelowVwap = priorCandle.close < vwap
		const crossedAboveVwap = c.close > vwap && c.close > c.open

		if (wasBelowVwap && crossedAboveVwap && isRealBody) {
			const best = getBestStrike('CE', c.close)
			const indexSl = Number(c.low.toFixed(2)) // SL is exactly the bottom of the crossover candle
			const risk = c.close - indexSl

			// Ignore if the crossover candle was massive (SL too wide)
			if (risk > 35) return

			const t1 = Number((c.close + risk * 1.5).toFixed(2))

			console.log(`\n🚀 [VWAP CROSSOVER CE] Nifty blasted through VWAP. Sniper entry at ${c.close}`)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} CE`,
				price: c.close,
				side: 'LONG',
				percentageChange: 0,
				volumeSpikeRatio: 1, // Spot index volume ignored
				trigger: `🚀 VWAP Breakout CE | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${c.close} | SL ₹${indexSl} | T1 ₹${t1} | ${best.reason}`,
				vwap,
				avgPrice: c.close,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}

		// ── SHORT SCALP: Bull-to-Bear Crossover (Trend Collapse) ───────────
		// 1. Previous candle closed ABOVE VWAP
		// 2. Current candle crashed through and closed BELOW VWAP

		const wasAboveVwap = priorCandle.close > vwap
		const crossedBelowVwap = c.close < vwap && c.close < c.open

		if (wasAboveVwap && crossedBelowVwap && isRealBody) {
			const best = getBestStrike('PE', c.close)
			const indexSl = Number(c.high.toFixed(2)) // SL is top of the breakdown candle
			const risk = indexSl - c.close

			if (risk > 35) return

			const t1 = Number((c.close - risk * 1.5).toFixed(2))

			console.log(`\n📉 [VWAP CROSSOVER PE] Nifty crashed through VWAP. Sniper entry at ${c.close}`)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} PE`,
				price: c.close,
				side: 'SHORT',
				percentageChange: 0,
				volumeSpikeRatio: 1,
				trigger: `📉 VWAP Breakdown PE | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${c.close} | SL ₹${indexSl} | T1 ₹${t1} | ${best.reason}`,
				vwap,
				avgPrice: c.close,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}
	}
}

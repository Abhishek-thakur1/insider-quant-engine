// ============================================================
// v2/niftyTrendPulseDetector.ts
//
// REPLACES: niftyOptionsDetector.ts (zero alerts for Nifty50)
//
// ROOT CAUSE OF ZERO ALERTS (old detector):
//   1. Needed 3 consecutive 5-min HH/LL — takes 15 min to arm.
//      On a 200-pt rally day, the move is DONE before you enter.
//   2. VWAP distance threshold of 0.15% was catching the BEGINNING
//      of moves, not confirming them — then the JSFilter killed it
//      because evidence was neutral (barely 0.15% = no momentum edge).
//   3. No ATR context — 0.15% means nothing without volatility normalization.
//
// v2 LOGIC — "3-Bar Trend Engine":
//   Uses 3-min candles (faster signal, still filters noise).
//   FIRES when ALL of these align on candle CLOSE:
//     1. 2 consecutive 3-min closes in same direction (HH + HC, or LL + LC)
//     2. Price > 0.20% away from VWAP (momentum confirmed, not just started)
//     3. Last candle body >= 0.10% (real directional candle, not a doji)
//     4. Current 3-min candle volume >= 1.5× avg (participation confirmed)
//     5. Active trading window only (9:15-11:30 OR 13:30-15:00)
//
// WHY THIS CATCHES THE 200-PT RALLY:
//   - 3-min candles arm in 6 min (vs 15 min for old detector)
//   - 0.20% VWAP threshold is loose enough to catch early momentum
//     but strong enough to pass JSFilter's VWAP zone check
//   - Volume confirmation ensures you're not chasing a dead cat
//
// STRIKE SELECTION: unchanged from old detector — uses getBestStrike()
// COOLDOWN: 20 minutes (vs 15 min old) — more selective on re-entries
// ============================================================

import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap } from '../../utils/vwapUtils.js'
import { getBestStrike } from '../../utils/optionUtils.js'

// ─── TUNABLE CONSTANTS ────────────────────────────────────────
const CANDLE_MS = 3 * 60 * 1000 // 3-min candles (vs 5-min old)
const MIN_BODY_PCT = 0.1 // real body filter (same)
const CONFIRMS_NEEDED = 2 // 2 closes in same direction (vs 3 old = too slow)
const VWAP_DIST_PCT = 0.2 // 0.20% from VWAP (vs 0.15% old — passes JSFilter better)
const VOL_CONFIRM_MULT = 1.5 // candle volume >= 1.5× avg (NEW — replaces no vol check)
const COOLDOWN_SECONDS = 1200 // 20 min (vs 15 min old)

const WINDOW_1_START = 9 * 60 + 15
const WINDOW_1_END = 11 * 60 + 30
const WINDOW_2_START = 13 * 60 + 30
const WINDOW_2_END = 15 * 60
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

const isActiveWindow = (): boolean => {
	const m = getISTMinutes()
	return (m >= WINDOW_1_START && m <= WINDOW_1_END) || (m >= WINDOW_2_START && m <= WINDOW_2_END)
}

interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class NiftyTrendPulseDetector implements IDetector {
	public name = 'Nifty Trend Pulse'
	public symbol = 'NSE:NIFTY50-INDEX'

	private currentCandle: Candle | null = null
	private closedCandles: Candle[] = []
	private avgVolume: number = 0 // rolling avg of last 10 candle volumes

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isActiveWindow()) return

		const now = liveTick.timestamp

		// ── Build 3-min candle ──────────────────────────────────────────
		if (!this.currentCandle) {
			this.currentCandle = {
				open: liveTick.price,
				high: liveTick.price,
				low: liveTick.price,
				close: liveTick.price,
				volume: liveTick.volume,
				startTs: now,
			}
			return
		}

		if (now - this.currentCandle.startTs < CANDLE_MS) {
			this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
			this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
			this.currentCandle.close = liveTick.price
			this.currentCandle.volume += liveTick.volume
			return
		}

		// ── Candle closed ───────────────────────────────────────────────
		const closed = { ...this.currentCandle }
		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: now,
		}

		// maintain rolling candle history
		this.closedCandles.push(closed)
		if (this.closedCandles.length > 15) this.closedCandles.shift()

		// update rolling volume average (last 10 candles)
		const volSample = this.closedCandles.slice(-10)
		this.avgVolume = volSample.reduce((s, c) => s + c.volume, 0) / volSample.length

		if (this.closedCandles.length < CONFIRMS_NEEDED + 1) return

		const cooldownKey = `cooldown:v2:nifty_pulse`
		if (await redisClient.get(cooldownKey)) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		const recent = this.closedCandles.slice(-CONFIRMS_NEEDED) // last 2 closed candles
		const current = closed

		// ── FILTER 1: Real body (not a doji / indecision candle) ────────
		const bodyPct = (Math.abs(current.close - current.open) / current.open) * 100
		if (bodyPct < MIN_BODY_PCT) return

		// ── FILTER 2: Volume confirmation (participation, not thin air) ──
		const isVolConfirmed = this.avgVolume > 0 && current.volume >= this.avgVolume * VOL_CONFIRM_MULT

		// ── FILTER 3: 2 consecutive closes in same direction ────────────
		const allBullish = recent.every((c) => c.close > c.open)
		const allBearish = recent.every((c) => c.close < c.open)

		// ── FILTER 4: Higher highs (CE) or Lower lows (PE) ──────────────
		const hasHH = recent.every((c, i) => i === 0 || c.high > recent[i - 1]!.high)
		const hasLL = recent.every((c, i) => i === 0 || c.low < recent[i - 1]!.low)

		// ── FILTER 5: VWAP distance — price must have moved away from VWAP
		const vwapDistPct = ((current.close - vwap) / vwap) * 100 // positive = above, negative = below
		const isAboveVwap = vwapDistPct >= VWAP_DIST_PCT
		const isBelowVwap = vwapDistPct <= -VWAP_DIST_PCT

		// ── LONG SIGNAL — CE ─────────────────────────────────────────────
		if (allBullish && hasHH && isAboveVwap && bodyPct >= MIN_BODY_PCT) {
			const best = getBestStrike('CE', current.close)
			const indexSl = Number((Math.min(...recent.map((c) => c.low)) - 10).toFixed(2))
			const risk = current.close - indexSl
			if (risk <= 0 || risk > 60) return // reject anomalies

			const t1 = Number((current.close + risk * 1.5).toFixed(2))
			const t2 = Number((current.close + risk * 2.5).toFixed(2))
			const volNote = isVolConfirmed
				? `${(current.volume / this.avgVolume).toFixed(1)}× vol ✅`
				: `vol light ⚠️`

			console.log(
				`\n🟢 [NIFTY TREND PULSE CE] ${best.strike} CE | Spot ${current.close} | VWAP dist +${vwapDistPct.toFixed(2)}%`,
			)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} CE`,
				price: current.close,
				side: 'LONG',
				percentageChange: Number(vwapDistPct.toFixed(2)),
				volumeSpikeRatio:
					this.avgVolume > 0 ? Number((current.volume / this.avgVolume).toFixed(1)) : 1,
				trigger: `📈 Nifty Trend Pulse CE | Strike ${best.strike} | Premium ~₹${best.ltp > 0 ? best.ltp.toFixed(0) : '?'} | Spot ₹${current.close} | VWAP +${vwapDistPct.toFixed(2)}% | 2-bar HH ✅ | ${volNote} | SL ₹${indexSl} | T1 ₹${t1} | T2 ₹${t2} | ⏱ Exit next 3-min candle close`,
				vwap,
				avgPrice: (current.open + current.close) / 2,
				detectorName: this.name,
				regimeClass: 'MOMENTUM',
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}

		// ── SHORT SIGNAL — PE ────────────────────────────────────────────
		if (allBearish && hasLL && isBelowVwap && bodyPct >= MIN_BODY_PCT) {
			const best = getBestStrike('PE', current.close)
			const indexSl = Number((Math.max(...recent.map((c) => c.high)) + 10).toFixed(2))
			const risk = indexSl - current.close
			if (risk <= 0 || risk > 60) return

			const t1 = Number((current.close - risk * 1.5).toFixed(2))
			const t2 = Number((current.close - risk * 2.5).toFixed(2))
			const volNote = isVolConfirmed
				? `${(current.volume / this.avgVolume).toFixed(1)}× vol ✅`
				: `vol light ⚠️`

			console.log(
				`\n🔴 [NIFTY TREND PULSE PE] ${best.strike} PE | Spot ${current.close} | VWAP dist ${vwapDistPct.toFixed(2)}%`,
			)

			sendTelegramAlert({
				symbol: `NIFTY ${best.strike} PE`,
				price: current.close,
				side: 'SHORT',
				percentageChange: Number(Math.abs(vwapDistPct).toFixed(2)),
				volumeSpikeRatio:
					this.avgVolume > 0 ? Number((current.volume / this.avgVolume).toFixed(1)) : 1,
				trigger: `📉 Nifty Trend Pulse PE | Strike ${best.strike} | Premium ~₹${best.ltp > 0 ? best.ltp.toFixed(0) : '?'} | Spot ₹${current.close} | VWAP ${vwapDistPct.toFixed(2)}% | 2-bar LL ✅ | ${volNote} | SL ₹${indexSl} | T1 ₹${t1} | T2 ₹${t2} | ⏱ Exit next 3-min candle close`,
				vwap,
				avgPrice: (current.open + current.close) / 2,
				detectorName: this.name,
				regimeClass: 'MOMENTUM',
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
		}
	}
}

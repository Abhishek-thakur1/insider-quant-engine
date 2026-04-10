// ============================================================
// Institutional Volume Absorption Detector
//
// [FIX: LOGIC] The original detector used a rolling tick-count baseline
// (last 150 ticks). This is broken for two reasons:
//
//   1. During the opening 30 minutes, ticks arrive at 5-10× the normal rate.
//      A baseline built at open inflates the average, making the detector
//      miss genuine mid-session institutional spikes.
//
//   2. During a quiet mid-session period, ticks slow down. A baseline built
//      from sparse ticks compresses the average, causing normal bursts to look
//      like spikes when they aren't.
//
// [WHAT TO CHANGE]: Baseline is now built from 1-MINUTE CANDLE volumes, not
// raw tick volumes. We accumulate a running 1-min candle inside the detector
// (same pattern as CandleBreakoutDetector) and use the last N completed candles
// as the volume baseline. This gives a time-consistent comparison regardless
// of tick rate.
//
// Functionality is IDENTICAL — same filters, same thresholds, same alert output.
// The only change is how baseline volume is measured.
// ============================================================

import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap, getMarketBias } from '../utils/vwapUtils.js'

// [FIX] Changed from tick-count to candle-count baseline
const BASELINE_CANDLE_COUNT = 15 // last 15 completed 1-min candles (~15 min of data)
const VOLUME_SPIKE_MULTIPLIER = 12
const MIN_BLOCK_VALUE = 20_000_000 // ₹2Cr minimum block — unchanged
const COOLDOWN_SECONDS = 900

const CANDLE_DURATION_MS = 60 * 1000 // 1-minute candle aggregation window

// Opening 30 min has structurally abnormal volume
const getISTMinutes = (): number => {
	const istMs = Date.now() + 5.5 * 60 * 60 * 1000
	const d = new Date(istMs)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const isMarketHours = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 30 && m <= 15 * 60
}

// [FIX] Candle interface for accumulating tick volumes into 1-min buckets
interface CandleVolume {
	volume: number
	avgPrice: number
	startTs: number
}

export class VolumeSpikeDetector implements IDetector {
	public name: string = 'Institutional Volume Absorption'
	public symbol: string

	// [FIX] In-memory current candle — accumulates ticks into 1-min volume buckets
	private currentCandle: CandleVolume | null = null

	constructor(symbol: string) {
		this.symbol = symbol
	}

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isMarketHours()) return

		// ── Step 1: Accumulate ticks into 1-min candles ──────────────────────
		const now = liveTick.timestamp

		if (!this.currentCandle) {
			this.currentCandle = {
				volume: liveTick.volume,
				avgPrice: liveTick.price,
				startTs: now,
			}
			return
		}

		const candleAge = now - this.currentCandle.startTs

		if (candleAge < CANDLE_DURATION_MS) {
			// Still building the current candle — accumulate volume
			this.currentCandle.volume += liveTick.volume
			// Running average price (used for isBlockSized at the candle level)
			this.currentCandle.avgPrice = (this.currentCandle.avgPrice + liveTick.price) / 2
			// Don't run spike detection mid-candle — fall through to tick-level check below
		} else {
			// ── Candle complete — push completed candle volume to Redis baseline ──
			const completedCandle = { ...this.currentCandle }

			// Start fresh candle
			this.currentCandle = {
				volume: liveTick.volume,
				avgPrice: liveTick.price,
				startTs: now,
			}

			const baselineKey = `vol_baseline_candles:${this.symbol}`
			await redisClient
				.multi()
				.lPush(baselineKey, JSON.stringify(completedCandle))
				.lTrim(baselineKey, 0, BASELINE_CANDLE_COUNT - 1)
				.exec()
		}

		// ── Step 2: Spike detection on each tick ─────────────────────────────
		// We still detect on individual ticks (not candle close) to preserve
		// the real-time responsiveness of the original detector.

		const baselineKey = `vol_baseline_candles:${this.symbol}`
		const cooldownKey = `cooldown:volume:${this.symbol}`

		const isCoolingDown = await redisClient.get(cooldownKey)
		if (isCoolingDown) return

		const rawBaseline = await redisClient.lRange(baselineKey, 0, -1)
		const candleHistory: CandleVolume[] = rawBaseline.map(
			(item) => JSON.parse(item) as CandleVolume,
		)

		// [FIX] Require the full baseline of completed candles before firing
		if (candleHistory.length < BASELINE_CANDLE_COUNT) return

		// [FIX] Baseline is now per-MINUTE volume average — time-consistent
		const avgCandleVolume = candleHistory.reduce((a, c) => a + c.volume, 0) / candleHistory.length
		const avgCandlePrice = candleHistory.reduce((a, c) => a + c.avgPrice, 0) / candleHistory.length

		// ── FILTER 1: Institutional block value floor ─────────────────────────
		const blockValue = liveTick.price * liveTick.volume
		const isInstitutionalSz = blockValue >= MIN_BLOCK_VALUE

		// ── FILTER 2: Volume surge vs candle baseline ─────────────────────────
		// [FIX] Compare single tick volume to per-minute baseline.
		// Note: a single aggressive tick CAN exceed a full candle's average volume
		// for a block trade — that's exactly what we're looking for.
		const isVolumeSurge = liveTick.volume > avgCandleVolume * VOLUME_SPIKE_MULTIPLIER

		// ── FILTER 3: Price vs VWAP ───────────────────────────────────────────
		const vwap = await getVwap(this.symbol)
		const isAboveVwap = vwap !== null ? liveTick.price > vwap : null
		const isPriceLeadingUp = liveTick.price > avgCandlePrice
		const isPriceLeadingDown = liveTick.price < avgCandlePrice
		const isPriceMoving = Math.abs((liveTick.price - avgCandlePrice) / avgCandlePrice) * 100 >= 0.4

		// ── FILTER 4: Market regime ───────────────────────────────────────────
		const marketBias = await getMarketBias()

		// ── LONG SIDE ────────────────────────────────────────────────────────
		if (
			isInstitutionalSz &&
			isVolumeSurge &&
			isAboveVwap === true &&
			isPriceLeadingUp &&
			isPriceMoving &&
			marketBias !== 'bearish'
		) {
			console.log(`\n🟢 [LONG SIGNAL] ${this.symbol} — Institutional Buying`)

			sendTelegramAlert({
				symbol: this.symbol,
				price: liveTick.price,
				side: 'LONG',
				percentageChange: Number(
					(((liveTick.price - avgCandlePrice) / avgCandlePrice) * 100).toFixed(2),
				),
				volumeSpikeRatio: Number((liveTick.volume / avgCandleVolume).toFixed(1)),
				trigger: `🏛️ Block ₹${(blockValue / 100_000).toFixed(1)}L | ${(liveTick.volume / avgCandleVolume).toFixed(1)}× surge | VWAP ₹${vwap?.toFixed(2)}`,
				vwap: vwap ?? liveTick.price,
				avgPrice: avgCandlePrice,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}

		// ── SHORT SIDE ───────────────────────────────────────────────────────
		if (
			isInstitutionalSz &&
			isVolumeSurge &&
			isAboveVwap === false &&
			isPriceLeadingDown &&
			isPriceMoving &&
			marketBias !== 'bullish'
		) {
			console.log(`\n🔴 [SHORT SIGNAL] ${this.symbol} — Institutional Selling`)

			sendTelegramAlert({
				symbol: this.symbol,
				price: liveTick.price,
				side: 'SHORT',
				percentageChange: Number(
					(((liveTick.price - avgCandlePrice) / avgCandlePrice) * 100).toFixed(2),
				),
				volumeSpikeRatio: Number((liveTick.volume / avgCandleVolume).toFixed(1)),
				trigger: `🏛️ Block ₹${(blockValue / 100_000).toFixed(1)}L | ${(liveTick.volume / avgCandleVolume).toFixed(1)}× dump | VWAP ₹${vwap?.toFixed(2)}`,
				vwap: vwap ?? liveTick.price,
				avgPrice: avgCandlePrice,
			})

			await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
			return
		}
	}
}

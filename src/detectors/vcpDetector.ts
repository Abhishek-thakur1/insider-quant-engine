import { sendTelegramAlert } from '../workers/telegramWorker.js'
import type { IDetector, TickData } from '../core/types.js'
import { redisClient } from '../config/redis.js'
import { getVwap, getMarketBias } from '../utils/vwapUtils.js'

const BOX_MEMORY_LENGTH = 20
const BASELINE_MEMORY_LENGTH = 100
const MIN_CONSOLIDATION_MS = 5 * 60 * 1000
const MAX_SPREAD_PCT = 0.5
const VOLUME_CONTRACTION_RATIO = 0.7
const BREAKOUT_VOL_MULTIPLIER = 5
const BREAKOUT_PRICE_BUFFER = 1.001
const FAILURE_PRICE_BUFFER = 0.999
const COOLDOWN_SECONDS = 1800
const MIN_BLOCK_VALUE = 5_000_000

const getISTMinutes = (): number => {
	const istMs = Date.now() + 5.5 * 60 * 60 * 1000
	const d = new Date(istMs)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}
const isMarketHours = (): boolean => {
	const m = getISTMinutes()
	return m >= 9 * 60 + 30 && m <= 15 * 60
}

export class VcpDetector implements IDetector {
	public name: string = 'VCP Institutional Breakout'
	public symbol: string

	// [FIX: RESILIENCE] The original `isArmed` was a plain in-memory boolean.
	// If the process crashed while a symbol was armed (coiled, waiting for breakout),
	// the state was lost — the detector would restart as disarmed and miss the breakout.
	//
	// [WHAT TO CHANGE]: `isArmed` is now persisted in Redis under
	// `armed:vcp:{symbol}`. We read it on every analyze() call and write it
	// on every state transition. The websocket.ts boot cleanup already deletes
	// this key on engine start (it deletes all vcp keys), so stale armed
	// state from the previous day is automatically cleared.
	//
	// The in-memory `_armedCache` is kept as a local cache to avoid a Redis
	// read on every single tick when we already know the state — we only
	// re-read from Redis on the first tick after construction.
	private _armedCache: boolean | null = null // null = "not yet read from Redis"
	private boxHistory: TickData[] = []
	private baselineHistory: TickData[] = []
	constructor(symbol: string) {
		this.symbol = symbol
	}

	// [FIX] Helper: get isArmed from Redis (with in-memory cache)
	private async getIsArmed(): Promise<boolean> {
		if (this._armedCache !== null) return this._armedCache
		const raw = await redisClient.get(`armed:vcp:${this.symbol}`)
		this._armedCache = raw === 'true'
		return this._armedCache
	}

	// [FIX] Helper: set isArmed in both Redis and local cache
	private async setIsArmed(value: boolean): Promise<void> {
		this._armedCache = value
		if (value) {
			// TTL of 8 hours — clears automatically at end of trading day
			await redisClient.setEx(`armed:vcp:${this.symbol}`, 8 * 3600, 'true')
		} else {
			await redisClient.del(`armed:vcp:${this.symbol}`)
		}
	}

	public async analyze(liveTick: TickData): Promise<void> {
		if (!isMarketHours()) return

		const boxKey = `memory:vcp:${this.symbol}`
		const baselineKey = `baseline:vcp:${this.symbol}`
		const cooldownKey = `cooldown:vcp:${this.symbol}`

		const isCoolingDown = await redisClient.get(cooldownKey)
		if (isCoolingDown) {
			await redisClient
				.multi()
				.lPush(baselineKey, JSON.stringify(liveTick))
				.lTrim(baselineKey, 0, BASELINE_MEMORY_LENGTH - 1)
				.exec()
			return
		}

		// const [rawBox, rawBaseline] = await Promise.all([
		// 	redisClient.lRange(boxKey, 0, -1),
		// 	redisClient.lRange(baselineKey, 0, -1),
		// ])

		// const boxHistory: TickData[] = rawBox.map((item) => JSON.parse(item) as TickData)
		// const baselineHistory: TickData[] = rawBaseline.map((item) => JSON.parse(item) as TickData)
		this.boxHistory.push(liveTick)
		if (this.boxHistory.length > BOX_MEMORY_LENGTH) this.boxHistory.shift()

		this.baselineHistory.push(liveTick)
		if (this.baselineHistory.length > BASELINE_MEMORY_LENGTH) this.baselineHistory.shift()
		redisClient
			.multi()
			.lPush(boxKey, JSON.stringify(liveTick))
			.lTrim(boxKey, 0, BOX_MEMORY_LENGTH - 1)
			.lPush(baselineKey, JSON.stringify(liveTick))
			.lTrim(baselineKey, 0, BASELINE_MEMORY_LENGTH - 1)
			.exec()
			.catch((err) => console.error('Redis sync error:', err))
		if (
			this.boxHistory.length >= BOX_MEMORY_LENGTH &&
			this.baselineHistory.length >= BASELINE_MEMORY_LENGTH
		) {
			const prices = this.boxHistory.map((t) => t.price)
			const boxVolumes = this.boxHistory.map((t) => t.volume)
			const baselineVols = this.baselineHistory.map((t) => t.volume)

			const boxHigh = Math.max(...prices)
			const boxLow = Math.min(...prices)
			const spreadPercent = ((boxHigh - boxLow) / boxLow) * 100
			const boxAvgVol = boxVolumes.reduce((a, b) => a + b, 0) / boxVolumes.length
			const baselineAvgVol = baselineVols.reduce((a, b) => a + b, 0) / baselineVols.length

			const oldestBoxTick = this.boxHistory[this.boxHistory.length - 1]
			const consolidationAge = Date.now() - (oldestBoxTick?.timestamp ?? Date.now())
			const isOldEnough = consolidationAge >= MIN_CONSOLIDATION_MS

			const isVolumeContracting = boxAvgVol < baselineAvgVol * VOLUME_CONTRACTION_RATIO

			// [FIX] Read armed state from Redis (with cache)
			const isArmed = await this.getIsArmed()

			// ── ARMED STATE: Watch for the breakout ───────────────────────────
			if (isArmed) {
				const isBreakingResistance = liveTick.price > boxHigh * BREAKOUT_PRICE_BUFFER
				const isVolumeExplosion = liveTick.volume > baselineAvgVol * BREAKOUT_VOL_MULTIPLIER
				const blockValue = liveTick.price * liveTick.volume
				const isInstitutionalSz = blockValue >= MIN_BLOCK_VALUE

				const vwap = await getVwap(this.symbol)
				const isAboveVwap = vwap !== null ? liveTick.price > vwap : true

				const marketBias = await getMarketBias()
				const isBullishMkt = marketBias !== 'bearish'

				if (
					isBreakingResistance &&
					isVolumeExplosion &&
					isAboveVwap &&
					isBullishMkt &&
					isInstitutionalSz
				) {
					console.log(`\n🏛️  [INSTITUTIONAL VCP] ${this.symbol} — Breakout CONFIRMED`)
					console.log(
						`   Box: ₹${boxLow.toFixed(2)} – ₹${boxHigh.toFixed(2)} | Spread: ${spreadPercent.toFixed(2)}%`,
					)
					console.log(
						`   Age: ${(consolidationAge / 60000).toFixed(1)} min | VWAP: ₹${vwap?.toFixed(2) ?? 'n/a'}`,
					)
					console.log(
						`   Vol Contraction: ${((boxAvgVol / baselineAvgVol) * 100).toFixed(0)}% of baseline ✅`,
					)
					console.log(
						`   Breakout vol: ${liveTick.volume.toLocaleString()} = ${(liveTick.volume / baselineAvgVol).toFixed(1)}× baseline ✅`,
					)

					sendTelegramAlert({
						symbol: this.symbol,
						price: liveTick.price,
						side: 'LONG',
						percentageChange: Number((((liveTick.price - boxLow) / boxLow) * 100).toFixed(2)),
						volumeSpikeRatio: Number((liveTick.volume / baselineAvgVol).toFixed(1)),
						trigger: `📦 VCP | Box ${(consolidationAge / 60000).toFixed(1)}min | Vol ${((boxAvgVol / baselineAvgVol) * 100).toFixed(0)}% contracted | ${(liveTick.volume / baselineAvgVol).toFixed(1)}× burst | ${vwap ? `VWAP ₹${vwap.toFixed(2)}` : ''}`,
						vwap: vwap ?? liveTick.price,
						avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
					})

					// [FIX] Persist disarmed state back to Redis
					await this.setIsArmed(false)
					await redisClient.multi().del(boxKey).setEx(cooldownKey, COOLDOWN_SECONDS, 'true').exec()
					return
				}

				const isBreakingSupport = liveTick.price < boxLow * 0.999
				const isBreakdownVolume = liveTick.volume > baselineAvgVol * BREAKOUT_VOL_MULTIPLIER
				const isBelowVwap = vwap !== null ? liveTick.price < vwap : false
				const isBearishMkt = marketBias !== 'bullish'

				if (isBreakingSupport && isBreakdownVolume && isBelowVwap && isBearishMkt) {
					console.log(`\n🔴 [VCP BREAKDOWN] ${this.symbol} — Institutional Flush`)

					sendTelegramAlert({
						symbol: this.symbol,
						price: liveTick.price,
						side: 'SHORT',
						percentageChange: Number((((liveTick.price - boxHigh) / boxHigh) * 100).toFixed(2)),
						volumeSpikeRatio: Number((liveTick.volume / baselineAvgVol).toFixed(1)),
						trigger: `📦 VCP Breakdown | Box ${(consolidationAge / 60000).toFixed(1)}min | ${(liveTick.volume / baselineAvgVol).toFixed(1)}× flush | VWAP ₹${vwap?.toFixed(2)}`,
						vwap: vwap ?? liveTick.price,
						avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
					})

					// [FIX] Persist disarmed state
					await this.setIsArmed(false)
					await redisClient.multi().del(boxKey).setEx(cooldownKey, COOLDOWN_SECONDS, 'true').exec()
					return
				}

				if (liveTick.price < boxLow * FAILURE_PRICE_BUFFER) {
					// [FIX] Persist disarmed state
					await this.setIsArmed(false)
					console.log(
						`\n❌ [VCP] ${this.symbol} — Pattern FAILED. Price broke below box. Clearing.`,
					)
					await redisClient.del(boxKey)
				}
			}

			// ── DISARMED STATE: Scan for arm condition ────────────────────────
			if (!isArmed) {
				if (spreadPercent < MAX_SPREAD_PCT && isOldEnough && isVolumeContracting) {
					// [FIX] Persist armed state to Redis
					await this.setIsArmed(true)
					console.log(`\n🔒 [VCP] ${this.symbol} — COILED & ARMED`)
					console.log(
						`   Spread: ${spreadPercent.toFixed(2)}% | Age: ${(consolidationAge / 60000).toFixed(1)}min`,
					)
					console.log(
						`   Vol: ${boxAvgVol.toFixed(0)} avg = ${((boxAvgVol / baselineAvgVol) * 100).toFixed(0)}% of baseline ← Contracting ✅`,
					)
				} else if (spreadPercent >= MAX_SPREAD_PCT && isArmed) {
					// [FIX] Persist disarmed state
					await this.setIsArmed(false)
					console.log(`\n🔓 [VCP] ${this.symbol} — Spread widened. Disarming.`)
				}
			}
		}

		await redisClient
			.multi()
			.lPush(boxKey, JSON.stringify(liveTick))
			.lTrim(boxKey, 0, BOX_MEMORY_LENGTH - 1)
			.lPush(baselineKey, JSON.stringify(liveTick))
			.lTrim(baselineKey, 0, BASELINE_MEMORY_LENGTH - 1)
			.exec()
	}
}

import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap, getMarketBias } from '../../utils/vwapUtils.js'

const CANDLE_DURATION_MS = 3 * 60 * 1000
const RANGE_END_MINUTES = 10 * 60 + 0
const PIERCE_BUFFER_PCT = 0.002
const VOL_MULTIPLIER = 2.5
const COOLDOWN_SECONDS = 7200

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

interface Candle {
	open: number
	high: number
	low: number
	close: number
	volume: number
	startTs: number
}

export class EquityLiquiditySweepDetector implements IDetector {
	public name = 'Equity Structural Liquidity Sweep'
	public symbol: string

	private currentCandle: Candle | null = null
	private history: Candle[] = []

	private state: 'BUILDING_RANGE' | 'WAITING' | 'PIERCED_HIGH' | 'PIERCED_LOW' = 'BUILDING_RANGE'
	private orh: number = 0
	private orl: number = Infinity

	constructor(symbol: string) {
		this.symbol = symbol
	}

	public async analyze(liveTick: TickData): Promise<void> {
		const m = getISTMinutes()

		if (m < RANGE_END_MINUTES) {
			this.orh = Math.max(this.orh, liveTick.price)
			this.orl = Math.min(this.orl, liveTick.price)
			return
		}

		if (this.state === 'BUILDING_RANGE') {
			if (this.orh === 0 || this.orl === Infinity) {
				this.state = 'WAITING'
				return
			}
			const rangeSpread = ((this.orh - this.orl) / this.orl) * 100
			if (rangeSpread < 0.3 || this.orh === 0 || this.orl === Infinity) {
				// FIX: guard against unbuilt range — skip this symbol today
				this.state = 'WAITING'
				return
			}
			this.state = 'WAITING'
			console.log(
				`[Equity Trap] 📊 Range Locked for ${this.symbol} | ORH: ₹${this.orh.toFixed(2)} ORL: ₹${this.orl.toFixed(2)}`,
			)
		}

		// FIX: additional guard — if range was never properly built, do nothing
		if (this.orh === 0 || this.orl === Infinity) return

		if (m > 15 * 60) return

		const now = liveTick.timestamp

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

		if (now - this.currentCandle.startTs < CANDLE_DURATION_MS) {
			this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price)
			this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price)
			this.currentCandle.close = liveTick.price
			this.currentCandle.volume += liveTick.volume
			this.evaluateLiveTrap(liveTick.price)
			return
		}

		const c = { ...this.currentCandle }
		this.history.push(c)
		if (this.history.length > 20) this.history.shift()

		this.currentCandle = {
			open: liveTick.price,
			high: liveTick.price,
			low: liveTick.price,
			close: liveTick.price,
			volume: liveTick.volume,
			startTs: now,
		}

		const cooldownKey = `cooldown:eq_sweep:${this.symbol}`
		if ((await redisClient.get(cooldownKey)) || this.history.length < 5) return

		const baseline = this.history.slice(0, -1)
		const avgVol = baseline.reduce((a, b) => a + b.volume, 0) / baseline.length
		const marketBias = await getMarketBias()
		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		if (this.state === 'PIERCED_HIGH') {
			if (c.close < this.orh) {
				const isNiftyAlignedShort = marketBias === 'bearish' || marketBias === 'neutral'
				const isCatalystDrivenShort =
					marketBias === 'bullish' &&
					c.close < vwap * 0.99 && // Rejected below VWAP
					c.volume > avgVol * VOL_MULTIPLIER * 1.5 // Requires 3.75x volume!

				if (
					c.volume > avgVol * VOL_MULTIPLIER &&
					c.close < c.open &&
					(isNiftyAlignedShort || isCatalystDrivenShort)
				) {
					await this.executeSignal('SHORT', c, this.orh, avgVol, vwap, cooldownKey)
				}
			} else if (c.close > this.orh * (1 + PIERCE_BUFFER_PCT * 2)) {
				this.state = 'WAITING'
			}
		}

		if (this.state === 'PIERCED_LOW') {
			if (c.close > this.orl) {
				const isNiftyAlignedLong = marketBias === 'bullish' || marketBias === 'neutral'
				const isCatalystDrivenLong =
					marketBias === 'bearish' &&
					c.close > vwap * 1.01 && // Recovered above VWAP
					c.volume > avgVol * VOL_MULTIPLIER * 1.5 // Requires 3.75x volume!

				if (
					c.volume > avgVol * VOL_MULTIPLIER &&
					c.close > c.open &&
					(isNiftyAlignedLong || isCatalystDrivenLong)
				) {
					await this.executeSignal('LONG', c, this.orl, avgVol, vwap, cooldownKey)
				}
			} else if (c.close < this.orl * (1 - PIERCE_BUFFER_PCT * 2)) {
				this.state = 'WAITING'
			}
		}
	}

	private evaluateLiveTrap(currentPrice: number) {
		if (this.state !== 'WAITING') return
		// FIX: guard against unbuilt range
		if (this.orh === 0 || this.orl === Infinity) return

		const pierceHighTarget = this.orh * (1 + PIERCE_BUFFER_PCT)
		const pierceLowTarget = this.orl * (1 - PIERCE_BUFFER_PCT)

		if (currentPrice >= pierceHighTarget) {
			console.log(`[Equity Trap] 🪤 ${this.symbol} pierced ORH. Arming Bear Trap.`)
			this.state = 'PIERCED_HIGH'
		} else if (currentPrice <= pierceLowTarget) {
			console.log(`[Equity Trap] 🪤 ${this.symbol} pierced ORL. Arming Bull Trap.`)
			this.state = 'PIERCED_LOW'
		}
	}

	private async executeSignal(
		side: 'LONG' | 'SHORT',
		candle: Candle,
		structuralLevel: number,
		avgVol: number,
		vwap: number,
		cooldownKey: string,
	) {
		const stopLoss =
			side === 'LONG' ? Number(candle.low.toFixed(2)) : Number(candle.high.toFixed(2))
		const risk = Math.abs(candle.close - stopLoss)
		const riskPct = (risk / candle.close) * 100

		if (riskPct > 1.5) {
			this.state = 'WAITING'
			return
		}

		const t1 = side === 'LONG' ? candle.close + risk * 2 : candle.close - risk * 2
		const t2 = side === 'LONG' ? candle.close + risk * 3 : candle.close - risk * 3

		console.log(`\n🎯 [EQUITY SWEEP ${side}] ${this.symbol} trapped retail at ₹${structuralLevel}`)

		sendTelegramAlert({
			symbol: this.symbol,
			price: candle.close,
			side: side,
			percentageChange: Number(
				(((candle.close - structuralLevel) / structuralLevel) * 100).toFixed(2),
			),
			volumeSpikeRatio: Number((candle.volume / avgVol).toFixed(1)),
			trigger: `🪤 ${side === 'LONG' ? 'Bear Trap (ORL Sweep)' : 'Bull Trap (ORH Sweep)'} | Rejected ₹${structuralLevel.toFixed(2)} | Vol ${(candle.volume / avgVol).toFixed(1)}x | SL ₹${stopLoss} | T1 ₹${t1.toFixed(2)} | T2 ₹${t2.toFixed(2)} | VWAP ₹${vwap.toFixed(2)}`,
			vwap: vwap,
			avgPrice: candle.close,
		})

		await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
		this.state = 'WAITING'
	}
}

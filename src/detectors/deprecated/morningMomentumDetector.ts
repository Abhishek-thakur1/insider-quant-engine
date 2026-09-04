import { sendTelegramAlert } from '../../workers/telegramWorker.js'
import type { IDetector, TickData } from '../../core/types.js'
import { redisClient } from '../../config/redis.js'
import { getVwap } from '../../utils/vwapUtils.js'

const RANGE_END_MINUTES = 9 * 60 + 20
const WINDOW_END_MINUTES = 9 * 60 + 45
const VOLUME_SPIKE_MULTIPLIER = 2.5
const BUFFER_PCT = 0.0005

const getISTMinutes = (): number => {
	const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

export class MorningMomentumDetector implements IDetector {
	public name = 'Morning Momentum Ignition'
	public symbol: string

	private orHigh: number = 0
	private orLow: number = Infinity
	private cumulativeVolume5m: number = 0
	private avgVolumePerMinute: number = 0
	private rangeLocked: boolean = false
	private currentMinute: number = 0
	private currentMinuteVolume: number = 0

	constructor(symbol: string) {
		this.symbol = symbol
	}

	public async analyze(liveTick: TickData): Promise<void> {
		const m = getISTMinutes()

		if (m >= WINDOW_END_MINUTES) return

		if (m < RANGE_END_MINUTES) {
			this.orHigh = Math.max(this.orHigh, liveTick.price)
			this.orLow = Math.min(this.orLow, liveTick.price)
			this.cumulativeVolume5m += liveTick.volume
			return
		}

		if (!this.rangeLocked) {
			if (this.orHigh === this.orLow || this.orHigh === 0) return

			// FIX: divide by 3 not 5 — opening 2 mins are ultra-dense tick-wise
			// dividing by 5 inflates baseline and makes isVolumeSpiking too hard to trigger
			this.avgVolumePerMinute = this.cumulativeVolume5m / 3
			this.rangeLocked = true
			console.log(
				`[Ignition] 🏎️ 9:20 Range Locked for ${this.symbol} | High: ₹${this.orHigh.toFixed(2)} | Low: ₹${this.orLow.toFixed(2)}`,
			)
		}

		if (m !== this.currentMinute) {
			this.currentMinute = m
			this.currentMinuteVolume = 0
		}
		this.currentMinuteVolume += liveTick.volume

		const firedKey = `fired:ignition:${this.symbol}`
		if (await redisClient.get(firedKey)) return

		const vwap = await getVwap(this.symbol)
		if (!vwap) return

		const isVolumeSpiking =
			this.avgVolumePerMinute > 0 &&
			this.currentMinuteVolume > this.avgVolumePerMinute * VOLUME_SPIKE_MULTIPLIER

		if (
			liveTick.price > this.orHigh * (1 + BUFFER_PCT) &&
			liveTick.price > vwap &&
			isVolumeSpiking
		) {
			await this.executeSignal('LONG', liveTick, this.orHigh, vwap, firedKey)
		} else if (
			liveTick.price < this.orLow * (1 - BUFFER_PCT) &&
			liveTick.price < vwap &&
			isVolumeSpiking
		) {
			await this.executeSignal('SHORT', liveTick, this.orLow, vwap, firedKey)
		}
	}

	private async executeSignal(
		side: 'LONG' | 'SHORT',
		tick: TickData,
		triggerLevel: number,
		vwap: number,
		firedKey: string,
	) {
		const stopLoss = vwap
		const risk = Math.abs(tick.price - stopLoss)
		if (risk <= 0) return

		const t1 = side === 'LONG' ? tick.price + risk * 2 : tick.price - risk * 2
		const t2 = side === 'LONG' ? tick.price + risk * 3 : tick.price - risk * 3

		console.log(
			`\n🏎️💨 [MORNING IGNITION ${side}] ${this.symbol} exploding past ₹${triggerLevel.toFixed(2)}`,
		)

		sendTelegramAlert({
			symbol: this.symbol,
			price: tick.price,
			side: side,
			percentageChange: Number((((tick.price - triggerLevel) / triggerLevel) * 100).toFixed(2)),
			volumeSpikeRatio: Number((this.currentMinuteVolume / this.avgVolumePerMinute).toFixed(1)),
			trigger: `🏎️💨 9:20 Momentum Ignition | ${(this.currentMinuteVolume / this.avgVolumePerMinute).toFixed(1)}× vol | SL (VWAP) ₹${stopLoss.toFixed(2)} | T1 ₹${t1.toFixed(2)} | T2 ₹${t2.toFixed(2)}`,
			vwap: vwap,
			avgPrice: tick.price,
		})

		// 12hr expiry — resets for next trading day automatically
		await redisClient.setEx(firedKey, 43200, 'true')
	}
}

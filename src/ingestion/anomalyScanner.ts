import fs from 'fs'
import path from 'path'

interface SymbolStats {
	advShares: number
	adr: number
	turnover: number
	close: number
}

export class AnomalyScanner {
	private stats: Record<string, SymbolStats> = {}
	private ringBuffer = new Map<string, { ltp: number; volToday: number }[]>()
	private latestTicks = new Map<string, { ltp: number; volToday: number }>()
	private cronTimer: NodeJS.Timeout | null = null

	public onPromote: (symbol: string, reason: string) => void = () => {}

	constructor() {
		const statsPath = path.resolve(process.cwd(), 'universe_stats.json')
		if (fs.existsSync(statsPath)) {
			this.stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'))
		} else {
			console.warn('[AnomalyScanner] ⚠️ universe_stats.json not found. Layer B scanning disabled.')
		}
	}

	public start(activeUniverse: Set<string>) {
		if (Object.keys(this.stats).length === 0) return

		console.log(
			`[AnomalyScanner] 📡 Starting background anomaly scan across ${Object.keys(this.stats).length} symbols...`,
		)
		
		this.cronTimer = setInterval(() => {
			this.processMinuteBoundary(activeUniverse)
		}, 60000)
	}

	public stop() {
		if (this.cronTimer) clearInterval(this.cronTimer)
	}

	// Called on every raw tick from Fyers (O(1) overhead)
	public updateTick(symbol: string, ltp: number, volToday: number) {
		this.latestTicks.set(symbol, { ltp, volToday })
	}

	private processMinuteBoundary(activeUniverse: Set<string>) {
		for (const [symbol, tick] of this.latestTicks.entries()) {
			if (activeUniverse.has(symbol)) continue // Already fully evaluated

			const symStats = this.stats[symbol]
			// Ignore pure penny/illiquid stocks even for anomaly screening
			if (!symStats || symStats.turnover < 10_000_000) continue 

			const history = this.ringBuffer.get(symbol) || []
			history.push(tick)
			
			if (history.length > 5) history.shift()
			this.ringBuffer.set(symbol, history)

			// We need a full 5-minute window to compare
			if (history.length === 5) {
				const oldest = history[0]!
				const current = history[4]!

				const vol5m = current.volToday - oldest.volToday
				const priceMove = Math.abs(current.ltp - oldest.ltp) / oldest.ltp

				// Criteria: 5% of daily volume in 5 mins AND > 1.5% price move
				// Also enforce a minimum absolute volume threshold to avoid penny stock spikes
				const volumeThreshold = Math.max(symStats.advShares * 0.05, 10000)
				const priceThreshold = 0.015

				if (vol5m > volumeThreshold && priceMove > priceThreshold) {
					const reason = `Moved ${(priceMove * 100).toFixed(1)}% on ${vol5m.toLocaleString()} shares in 5m`
					this.onPromote(symbol, reason)
					// clear buffer so it doesn't trigger repeatedly in the same minute
					this.ringBuffer.delete(symbol) 
				}
			}
		}
	}
}

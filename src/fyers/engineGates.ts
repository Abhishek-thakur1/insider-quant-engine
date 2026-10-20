// ============================================================
// fyers/engineGates.ts — the engine's Data-API gates (VWAP seeder, anomaly promotions)
//
// One limiter for the whole engine process (seeder + anomaly together stay within
// 4/s and 40/min) and the Redis ledger shared with the quant_screener container,
// so every EC2 job draws on the same daily count. Never throws at construction:
// if config/fyers_quota.json can't be read, the documented defaults are used.
// ============================================================

import { redisClient } from '../config/redis.js'
import { createMultiWindowLimiter, createQuotaGate, loadQuotaConfig, RedisLedger, validateQuotaConfig, type QuotaConfig, type QuotaGate, type QuotaJob } from './quota.js'

const DEFAULTS: QuotaConfig = validateQuotaConfig({
	dataApi: { perSecond: 4, perMinute: 40, perDay: 5000 },
	allocations: { screener: 2200, seeder: 300, anomaly: 200, backtest: 1500 },
	maxBreachesPerDay: 2,
	cooldownMs: 65_000,
	maxRetries: 3,
})

let shared: { config: QuotaConfig; limiter: ReturnType<typeof createMultiWindowLimiter>; gates: Map<QuotaJob, QuotaGate> } | null = null

export const engineGate = (job: 'seeder' | 'anomaly'): QuotaGate => {
	if (!shared) {
		let config = DEFAULTS
		try {
			config = loadQuotaConfig()
		} catch (err) {
			console.error('[FyersQuota] config/fyers_quota.json unreadable — using documented defaults:', (err as Error).message)
		}
		const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }
		const limiter = createMultiWindowLimiter(
			[
				{ max: config.dataApi.perSecond, windowMs: 1000 },
				{ max: config.dataApi.perMinute, windowMs: 60_000 },
			],
			clock,
		)
		shared = { config, limiter, gates: new Map() }
	}
	let g = shared.gates.get(job)
	if (!g) {
		g = createQuotaGate({ job, config: shared.config, ledger: new RedisLedger(redisClient), limiter: shared.limiter })
		shared.gates.set(job, g)
	}
	return g
}

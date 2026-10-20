// ============================================================
// screener/config.ts — load + validate config/screener.json
//
// Every threshold the screener uses lives in that one file. Its hash is written
// into every output and every backtest run, so a result always names the exact
// settings that produced it. Thresholds are fixed BEFORE a backtest; changing one
// afterwards is a second, labelled run.
// ============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface ScreenerConfig {
	version: number
	benchmark: string
	watchlistCap: number
	liquidity: { minAvgTurnoverRupees: number; turnoverLookbackBars: number; minPrice: number }
	history: { minBars: number }
	relativeStrength: { lookbacks: number[]; weights: number[] }
	residualMomentum: { lookbackBars: number }
	proximity: { highLookbackBars: number; maxBelowHighPct: number }
	trend: { emaPeriods: number[]; sma: number; smaRisingLookbackBars: number; emaWindowBars: number }
	tradability: {
		minAdrPct: number
		adrLookbackBars: number
		volumeShortBars: number
		volumeLongBars: number
		minVolumeRatio: number
	}
	tags: {
		tightRangeBars: number
		tightMaxRangeAdrMultiple: number
		tightVolumeBars: number
		tightVolumeBaseBars: number
		tightMaxVolumeRatio: number
		surgeVolumeMultiple: number
	}
	score: { rsWeight: number; residualWeight: number; proximityWeight: number }
	tiers: { tier1MinRsRank: number; tier2MinRsRank: number; holdMinRsRank: number }
	layerB: { maxSymbols: number; minTurnoverRupees: number; note: string }
	failureBudget: { maxFailedPct: number; maxNoDataPct: number }
	filters: { marketCap: string; asmGsm: string; seriesNote: string }
}

export const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), 'config', 'screener.json')

const fail = (msg: string): never => {
	throw new Error(`config/screener.json: ${msg}`)
}

const posNum = (v: unknown, name: string): number => {
	if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${name} must be a positive number`)
	return v as number
}

/** Throws with a specific message on any invalid field. */
export const validateConfig = (raw: unknown): ScreenerConfig => {
	const c = raw as ScreenerConfig
	if (!c || typeof c !== 'object') fail('not an object')
	if (typeof c.benchmark !== 'string' || !c.benchmark.endsWith('-INDEX')) fail('benchmark must be an index symbol')
	posNum(c.watchlistCap, 'watchlistCap')
	posNum(c.liquidity?.minAvgTurnoverRupees, 'liquidity.minAvgTurnoverRupees')
	posNum(c.liquidity?.turnoverLookbackBars, 'liquidity.turnoverLookbackBars')
	posNum(c.liquidity?.minPrice, 'liquidity.minPrice')
	posNum(c.history?.minBars, 'history.minBars')
	const rs = c.relativeStrength
	if (!Array.isArray(rs?.lookbacks) || !Array.isArray(rs?.weights) || rs.lookbacks.length !== rs.weights.length || rs.lookbacks.length === 0)
		fail('relativeStrength.lookbacks and weights must be equal-length arrays')
	rs.lookbacks.forEach((n, i) => posNum(n, `relativeStrength.lookbacks[${i}]`))
	if (Math.abs(rs.weights.reduce((a, b) => a + b, 0) - 1) > 1e-9) fail('relativeStrength.weights must sum to 1')
	posNum(c.residualMomentum?.lookbackBars, 'residualMomentum.lookbackBars')
	posNum(c.proximity?.highLookbackBars, 'proximity.highLookbackBars')
	posNum(c.proximity?.maxBelowHighPct, 'proximity.maxBelowHighPct')
	if (!Array.isArray(c.trend?.emaPeriods) || c.trend.emaPeriods.length !== 3) fail('trend.emaPeriods must have 3 periods')
	posNum(c.trend.sma, 'trend.sma')
	posNum(c.trend.smaRisingLookbackBars, 'trend.smaRisingLookbackBars')
	// EMAs are computed over a FIXED trailing window so the value for a date doesn't
	// depend on how much history happens to be cached (live vs backtest identical).
	if (posNum(c.trend.emaWindowBars, 'trend.emaWindowBars') < 4 * Math.max(...c.trend.emaPeriods)) fail('trend.emaWindowBars must be >= 4x the longest EMA period')
	for (const k of ['minAdrPct', 'adrLookbackBars', 'volumeShortBars', 'volumeLongBars', 'minVolumeRatio'] as const)
		posNum(c.tradability?.[k], `tradability.${k}`)
	for (const k of ['tightRangeBars', 'tightMaxRangeAdrMultiple', 'tightVolumeBars', 'tightVolumeBaseBars', 'tightMaxVolumeRatio', 'surgeVolumeMultiple'] as const)
		posNum(c.tags?.[k], `tags.${k}`)
	const s = c.score
	if (Math.abs(posNum(s?.rsWeight, 'score.rsWeight') + posNum(s.residualWeight, 'score.residualWeight') + posNum(s.proximityWeight, 'score.proximityWeight') - 1) > 1e-9)
		fail('score weights must sum to 1')
	for (const k of ['tier1MinRsRank', 'tier2MinRsRank', 'holdMinRsRank'] as const) {
		const v = posNum(c.tiers?.[k], `tiers.${k}`)
		if (v > 99) fail(`tiers.${k} must be a percentile 1–99`)
	}
	if (c.tiers.holdMinRsRank > c.tiers.tier1MinRsRank) fail('tiers.holdMinRsRank must not exceed tier1MinRsRank (hysteresis)')
	posNum(c.layerB?.maxSymbols, 'layerB.maxSymbols')
	posNum(c.layerB?.minTurnoverRupees, 'layerB.minTurnoverRupees')
	posNum(c.failureBudget?.maxFailedPct, 'failureBudget.maxFailedPct')
	posNum(c.failureBudget?.maxNoDataPct, 'failureBudget.maxNoDataPct')
	return c
}

/** Stable hash of the config content (key order and whitespace independent). */
export const configHash = (c: ScreenerConfig): string => {
	const canon = (v: unknown): unknown =>
		Array.isArray(v)
			? v.map(canon)
			: v && typeof v === 'object'
				? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
				: v
	return crypto.createHash('sha256').update(JSON.stringify(canon(c))).digest('hex').slice(0, 12)
}

export const loadConfig = (file = process.env.SCREENER_CONFIG || DEFAULT_CONFIG_PATH): { config: ScreenerConfig; hash: string } => {
	const config = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
	return { config, hash: configHash(config) }
}

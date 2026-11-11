// ============================================================
// backtest/bt6m/niftyHistory.ts — Nifty opening ranges and "why no alert" reasons over the cached history
//
// Owner extra (a), 10 Nov: read-only and local, no Fyers call. Replays the cached Nifty 1-minute bars
// (backtest/data/cache/res-1) through the three live Nifty detectors (Opening Range Explosion, Trend Pulse,
// VWAP Reclaim), unchanged, in the harness (memory Redis, virtual clock), and tallies:
//   - the opening range (09:15–09:20 high − low, from the bars) per session, and how many are >= 70 points;
//   - every noteBlocked() reason per detector (src/core/detectorDiagnostics.ts), and the fires per detector.
// No filter outcome or R is computed here. Output: JSON to stdout (and BT6M_OUT if set).
// Usage: BACKTEST_MODE=true BACKTEST_RES=1 npx tsx backtest/bt6m/niftyHistory.ts
// ============================================================

import '../core/bootEnv.js'

import fs from 'node:fs'
import { NIFTY_SYMBOL } from '../config.js'
import { installVirtualClock, istDateStringOf, istEpoch, istMinutesOf } from '../core/clock.js'
import { installMemoryRedis } from '../core/memoryRedis.js'
import { REGISTRY } from '../registry.js'
import { barsInRange, loadSeries, type Bar } from '../data/store.js'
import { replaySession } from '../replay/engine.js'
import { recentDiagnostics } from '../../src/core/detectorDiagnostics.js'

const IDS = ['nifty_opening_range_explosion', 'nifty_trend_pulse', 'nifty_vwap_reclaim']
const DAY_MS = 86_400_000

export const openingRange = (bars: Bar[]): number | null => {
	const first = bars.filter((b) => { const m = istMinutesOf(b.t); return m >= 9 * 60 + 15 && m < 9 * 60 + 20 })
	if (first.length < 5) return null
	return Math.max(...first.map((b) => b.h)) - Math.min(...first.map((b) => b.l))
}

const main = async (): Promise<void> => {
	if (process.env.BACKTEST_MODE !== 'true') throw new Error('BACKTEST_MODE=true is required')
	if ((process.env.BACKTEST_RES ?? '5') !== '1') throw new Error('BACKTEST_RES=1 is required (1-minute bars)')
	const series = loadSeries(NIFTY_SYMBOL, '1')
	if (!series?.bars.length) throw new Error('no cached Nifty 1-minute series')
	const specs = REGISTRY.filter((s) => IDS.includes(s.id))
	if (specs.length !== 3) throw new Error(`expected 3 Nifty specs, found ${specs.length}`)
	const days = [...new Set(series.bars.map((b) => istDateStringOf(b.t)))].sort()

	const { uninstall } = installMemoryRedis()
	const uninstallClock = installVirtualClock(istEpoch(days[0]!, 9 * 60 + 15))
	const reasons: Record<string, Record<string, number>> = {}
	const fires: Record<string, number> = {}
	const daysWithReason: Record<string, Record<string, number>> = {}
	const or: { day: string; range: number | null; reasons: Record<string, Record<string, number>>; fires: Record<string, number> }[] = []
	const log = console.log
	let sessions = 0
	try {
		for (const day of days) {
			const bars = barsInRange(series.bars, istEpoch(day, 0), istEpoch(day, 0) + DAY_MS)
			if (bars.length < 300) continue // half or broken sessions: skipped and counted below
			const day0: { day: string; range: number | null; reasons: Record<string, Record<string, number>>; fires: Record<string, number> } = { day, range: openingRange(bars), reasons: {}, fires: {} }
			or.push(day0)
			console.log = () => {} // the detectors' [Diag] lines; the records are read below
			const res = await replaySession({ sessionDate: day, barsBySymbol: new Map([[NIFTY_SYMBOL, bars]]), specs })
			console.log = log
			sessions++
			const seen = new Set<string>()
			for (const r of recentDiagnostics()) {
				;(reasons[r.detector] ??= {})[r.reason] = (reasons[r.detector]![r.reason] ?? 0) + 1
				;(day0.reasons[r.detector] ??= {})[r.reason] = (day0.reasons[r.detector]![r.reason] ?? 0) + 1
				const k = `${r.detector}|${r.reason}`
				if (!seen.has(k)) { seen.add(k); (daysWithReason[r.detector] ??= {})[r.reason] = (daysWithReason[r.detector]![r.reason] ?? 0) + 1 }
			}
			for (const s of res.signals) {
				fires[s.detectorId] = (fires[s.detectorId] ?? 0) + 1
				day0.fires[s.detectorId] = (day0.fires[s.detectorId] ?? 0) + 1
			}
		}
	} finally {
		console.log = log
		uninstallClock()
		uninstall()
	}
	const ranges = or.map((o) => o.range).filter((r): r is number => r !== null).sort((a, b) => a - b)
	const q = (p: number) => ranges[Math.min(ranges.length - 1, Math.floor(p * ranges.length))]
	const byYear: Record<string, { sessions: number; ge70: number }> = {}
	for (const o of or) {
		if (o.range === null) continue
		const y = o.day.slice(0, 4)
		byYear[y] ??= { sessions: 0, ge70: 0 }
		byYear[y].sessions++
		if (o.range >= 70) byYear[y].ge70++
	}
	const out = {
		source: `cache res-1 ${NIFTY_SYMBOL}, fetched ${series.fetchedAt}`,
		calendarDaysInCache: days.length,
		sessionsReplayed: sessions,
		sessionsSkippedShort: days.length - sessions,
		firstDay: or[0]?.day,
		lastDay: or[or.length - 1]?.day,
		openingRange: {
			sessionsWithRange: ranges.length,
			ge70: ranges.filter((r) => r >= 70).length,
			ge80: ranges.filter((r) => r >= 80).length,
			ge120: ranges.filter((r) => r >= 120).length,
			median: q(0.5),
			p10: q(0.1),
			p90: q(0.9),
			byYear,
		},
		fires,
		blockRecords: reasons,
		sessionsWithReason: daysWithReason,
		perDay: or,
	}
	const text = JSON.stringify(out, null, 1)
	if (process.env.BT6M_OUT) fs.writeFileSync(process.env.BT6M_OUT, text)
	log(JSON.stringify({ ...out, perDay: undefined }, null, 1))
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })

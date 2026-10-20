// ============================================================
// backtest/compare.ts — universe comparison: metrics, bootstrap CIs, go-live verdict
//
// Reads the per-label trade files the harness writes (trades_<label>.json) for
// the same window and detectors, and compares universes:
//   (a) old   (b) new   (c) random1..3
//
// Confidence intervals use a DAY-BLOCK bootstrap: whole sessions are resampled
// with replacement, because trades on the same day share the market and are not
// independent. Differences are PAIRED by day (the same resampled days for both
// universes), which is valid because every universe covers the same sessions.
//
// Go-live rule (owner-approved 2026-10-20, fixed before any run), on GATED trades
// pooled over the live equity detectors:
//   E[R](new) >= E[R](old)  and  E[R](new) >= mean of E[R](random1..3)
//   lower 95% CI of (new − old) >= −0.05R and of (new − mean random) >= −0.05R
//   n(new) >= 100
// A pass that is still negative expectancy is reported as exactly that.
// ============================================================

export interface TradeLite {
	r: number
	sessionDate: string
	entryTs: number
	gatePassed: boolean
	detectorId: string
}

export interface Summary {
	n: number
	winRate: number | null
	expectancyR: number | null
	ci95: [number, number] | null
	/** Distinct sessions with at least one trade. */
	tradeDays: number
	profitFactor: number | null
	maxDrawdownR: number
	sufficient: boolean
}

export const MIN_SAMPLE = 30
/**
 * A day-block CI needs trades on enough distinct sessions. With trades on one
 * day, every resample has the same mean and the "interval" collapses to a point
 * — false certainty (seen in the synthetic smoke run). Below this, no CI.
 */
export const MIN_CI_DAYS = 10
export const GO_LIVE = { minPooledGatedTrades: 100, maxDiffShortfallR: -0.05, iterations: 10_000, seed: 20261020 }

const rng = (seed: number) => () => {
	seed |= 0
	seed = (seed + 0x6d2b79f5) | 0
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const quant = (sorted: number[], q: number) => {
	if (sorted.length === 0) return NaN
	const pos = (sorted.length - 1) * q
	const lo = Math.floor(pos)
	const hi = Math.ceil(pos)
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

const byDay = (trades: TradeLite[]): Map<string, { sum: number; n: number }> => {
	const m = new Map<string, { sum: number; n: number }>()
	for (const t of trades) {
		const d = m.get(t.sessionDate) ?? { sum: 0, n: 0 }
		d.sum += t.r
		d.n++
		m.set(t.sessionDate, d)
	}
	return m
}

/**
 * Resample `days` with replacement `iterations` times; for each sample compute
 * `stat` from per-universe (sum, n) totals. Returns the sorted statistic values.
 */
const bootstrap = (
	days: string[],
	groups: Map<string, { sum: number; n: number }>[],
	stat: (totals: { sum: number; n: number }[]) => number | null,
	iterations = GO_LIVE.iterations,
	seed = GO_LIVE.seed,
): number[] => {
	const rand = rng(seed)
	const out: number[] = []
	for (let it = 0; it < iterations; it++) {
		const totals = groups.map(() => ({ sum: 0, n: 0 }))
		for (let k = 0; k < days.length; k++) {
			const d = days[Math.floor(rand() * days.length)]!
			groups.forEach((g, gi) => {
				const x = g.get(d)
				if (x) {
					totals[gi]!.sum += x.sum
					totals[gi]!.n += x.n
				}
			})
		}
		const v = stat(totals)
		if (v !== null && Number.isFinite(v)) out.push(v)
	}
	return out.sort((a, b) => a - b)
}

const meanOf = (t: { sum: number; n: number }) => (t.n > 0 ? t.sum / t.n : null)

export const summarize = (trades: TradeLite[], days: string[], seed = GO_LIVE.seed, iterations = GO_LIVE.iterations): Summary => {
	const n = trades.length
	const ordered = trades.slice().sort((a, b) => a.entryTs - b.entryTs)
	let cum = 0
	let peak = 0
	let dd = 0
	for (const t of ordered) {
		cum += t.r
		peak = Math.max(peak, cum)
		dd = Math.max(dd, peak - cum)
	}
	const wins = trades.filter((t) => t.r > 0)
	const gw = wins.reduce((a, t) => a + t.r, 0)
	const gl = Math.abs(trades.filter((t) => t.r <= 0).reduce((a, t) => a + t.r, 0))
	const tradeDays = new Set(trades.map((t) => t.sessionDate)).size
	const boot = tradeDays >= MIN_CI_DAYS ? bootstrap(days, [byDay(trades)], ([x]) => meanOf(x!), iterations, seed) : []
	return {
		n,
		winRate: n ? wins.length / n : null,
		expectancyR: n ? trades.reduce((a, t) => a + t.r, 0) / n : null,
		ci95: boot.length ? [quant(boot, 0.025), quant(boot, 0.975)] : null,
		tradeDays,
		profitFactor: gl > 0 ? gw / gl : null,
		maxDrawdownR: dd,
		sufficient: n >= MIN_SAMPLE,
	}
}

/** Paired day-block CI of mean(a) − mean(mean of bs). */
export const diffCI = (a: TradeLite[], bs: TradeLite[][], days: string[], seed = GO_LIVE.seed, iterations = GO_LIVE.iterations): [number, number] | null => {
	const groups = [byDay(a), ...bs.map(byDay)]
	if (groups.some((g) => g.size < MIN_CI_DAYS)) return null
	const boot = bootstrap(
		days,
		groups,
		(totals) => {
			const ma = meanOf(totals[0]!)
			const others = totals.slice(1).map(meanOf)
			if (ma === null || others.some((x) => x === null)) return null
			return ma - (others as number[]).reduce((x, y) => x + y, 0) / others.length
		},
		iterations,
		seed,
	)
	return boot.length ? [quant(boot, 0.025), quant(boot, 0.975)] : null
}

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE'

export interface Comparison {
	days: string[]
	pooledGated: Record<string, Summary>
	pooledUngated: Record<string, Summary>
	perDetector: Record<string, Record<string, { gated: Summary; ungated: Summary }>>
	diffVsOld: [number, number] | null
	diffVsRandom: [number, number] | null
	verdict: Verdict
	reasons: string[]
	negativeExpectancyStatement: string | null
}

/** trades[label][detectorId] = trades. `pooled` = detector ids pooled for the verdict (live equity detectors). */
export const compareUniverses = (
	trades: Record<string, Record<string, TradeLite[]>>,
	pooled: string[],
	opts: { iterations?: number; seed?: number } = {},
): Comparison => {
	const it = opts.iterations ?? GO_LIVE.iterations
	const seed = opts.seed ?? GO_LIVE.seed
	const labels = Object.keys(trades)
	const randoms = labels.filter((l) => l.startsWith('random')).sort()
	for (const need of ['old', 'new']) if (!labels.includes(need)) throw new Error(`missing trades for universe "${need}"`)
	if (randoms.length === 0) throw new Error('missing random control universes')

	const days = [...new Set(labels.flatMap((l) => Object.values(trades[l]!).flat().map((t) => t.sessionDate)))].sort()
	const pool = (l: string, gated: boolean) => pooled.flatMap((d) => trades[l]![d] ?? []).filter((t) => !gated || t.gatePassed)

	const pooledGated: Record<string, Summary> = {}
	const pooledUngated: Record<string, Summary> = {}
	const perDetector: Comparison['perDetector'] = {}
	for (const l of labels) {
		pooledGated[l] = summarize(pool(l, true), days, seed, it)
		pooledUngated[l] = summarize(pool(l, false), days, seed, it)
		for (const [det, ts] of Object.entries(trades[l]!)) {
			perDetector[det] ??= {}
			perDetector[det]![l] = { gated: summarize(ts.filter((t) => t.gatePassed), days, seed, it), ungated: summarize(ts, days, seed, it) }
		}
	}

	const nb = pool('new', true)
	const diffVsOld = diffCI(nb, [pool('old', true)], days, seed, it)
	const diffVsRandom = diffCI(nb, randoms.map((r) => pool(r, true)), days, seed, it)
	const eNew = pooledGated.new!.expectancyR
	const eOld = pooledGated.old!.expectancyR
	const randMeans = randoms.map((r) => pooledGated[r]!.expectancyR)
	const eRand = randMeans.every((x) => x !== null) ? (randMeans as number[]).reduce((a, b) => a + b, 0) / randMeans.length : null

	const reasons: string[] = []
	let verdict: Verdict = 'PASS'
	if (nb.length < GO_LIVE.minPooledGatedTrades) {
		verdict = 'INCONCLUSIVE'
		reasons.push(`only ${nb.length} pooled gated trades for "new" (< ${GO_LIVE.minPooledGatedTrades})`)
	}
	if (eNew === null || eOld === null || eRand === null) {
		verdict = 'INCONCLUSIVE'
		reasons.push('an expectancy is undefined (no gated trades in some universe)')
	} else {
		if (eNew < eOld) {
			verdict = verdict === 'INCONCLUSIVE' ? verdict : 'FAIL'
			reasons.push(`E[R] new ${eNew.toFixed(3)} < old ${eOld.toFixed(3)}`)
		}
		if (eNew < eRand) {
			verdict = verdict === 'INCONCLUSIVE' ? verdict : 'FAIL'
			reasons.push(`E[R] new ${eNew.toFixed(3)} < random mean ${eRand.toFixed(3)}`)
		}
	}
	for (const [name, ci] of [['old', diffVsOld], ['random mean', diffVsRandom]] as const) {
		if (!ci) {
			if (verdict === 'PASS') verdict = 'INCONCLUSIVE'
			reasons.push(`no CI for new − ${name}`)
		} else if (ci[0] < GO_LIVE.maxDiffShortfallR) {
			if (verdict === 'PASS') verdict = 'INCONCLUSIVE'
			reasons.push(`lower 95% bound of (new − ${name}) = ${ci[0].toFixed(3)}R < ${GO_LIVE.maxDiffShortfallR}R`)
		}
	}
	if (verdict === 'PASS') reasons.push('all go-live conditions met')

	const negativeExpectancyStatement =
		eNew !== null && eNew < 0
			? `The new universe ${verdict === 'PASS' ? 'is "not worse" than the old list and the random controls, but it' : ''} still has NEGATIVE expectancy: ${eNew.toFixed(3)}R per gated trade${pooledGated.new!.ci95 ? ` (95% CI ${pooledGated.new!.ci95[0].toFixed(3)} to ${pooledGated.new!.ci95[1].toFixed(3)})` : ''}. A wider or trendier universe produces more trades of a losing strategy, not a winning one.`.replace(/ {2,}/g, ' ')
			: null

	return { days, pooledGated, pooledUngated, perDetector, diffVsOld, diffVsRandom, verdict, reasons, negativeExpectancyStatement }
}

const fmt = (x: number | null, d = 3) => (x === null ? '—' : x.toFixed(d))
const ci = (c: [number, number] | null) => (c ? `[${c[0].toFixed(3)}, ${c[1].toFixed(3)}]` : '—')
const ciCell = (s: Summary) => (s.ci95 ? ci(s.ci95) : s.n > 0 && s.tradeDays < MIN_CI_DAYS ? `— (trades on ${s.tradeDays} day${s.tradeDays === 1 ? '' : 's'} < ${MIN_CI_DAYS})` : '—')
const row = (label: string, s: Summary) =>
	`| ${label} | ${s.n} | ${s.winRate === null ? '—' : (s.winRate * 100).toFixed(1) + '%'} | ${fmt(s.expectancyR)} | ${ciCell(s)} | ${fmt(s.profitFactor, 2)} | ${s.maxDrawdownR.toFixed(1)} | ${s.sufficient ? 'ok' : '**INSUFFICIENT (n < 30) — no conclusion**'} |`

export const renderMarkdown = (c: Comparison, meta: { window: string; resolution: string; configHash: string; pooled: string[]; names: Record<string, string> }): string => {
	const head = '| universe | n | win | E[R] | 95% CI (day-block) | PF | max DD (R) | sample |\n|---|---|---|---|---|---|---|---|'
	const labels = Object.keys(c.pooledGated).sort((a, b) => ['old', 'new'].indexOf(b) - ['old', 'new'].indexOf(a) || a.localeCompare(b))
	const lines = [
		`# Screener v2 — universe comparison`,
		'',
		`Window ${meta.window} · ${c.days.length} sessions with trades · ${meta.resolution}-minute bars · screener config ${meta.configHash}`,
		'',
		`## Verdict: **${c.verdict}**`,
		'',
		...c.reasons.map((r) => `- ${r}`),
		'',
		...(c.negativeExpectancyStatement ? [`> **${c.negativeExpectancyStatement}**`, ''] : []),
		`Difference in gated E[R], paired day-block bootstrap (${GO_LIVE.iterations.toLocaleString()} resamples):`,
		`- new − old: ${ci(c.diffVsOld)}`,
		`- new − mean(random): ${ci(c.diffVsRandom)}`,
		'',
		`## Pooled live equity detectors (${meta.pooled.join(', ')}) — GATED`,
		'',
		head,
		...labels.map((l) => row(meta.names[l] ?? l, c.pooledGated[l]!)),
		'',
		'## Pooled — UNGATED (every signal, filter ignored)',
		'',
		head,
		...labels.map((l) => row(meta.names[l] ?? l, c.pooledUngated[l]!)),
		'',
		'## Per detector',
	]
	for (const [det, byLabel] of Object.entries(c.perDetector).sort()) {
		lines.push('', `### ${det}`, '', '**Gated**', '', head, ...labels.filter((l) => byLabel[l]).map((l) => row(meta.names[l] ?? l, byLabel[l]!.gated)))
		lines.push('', '**Ungated**', '', head, ...labels.filter((l) => byLabel[l]).map((l) => row(meta.names[l] ?? l, byLabel[l]!.ungated)))
	}
	lines.push(
		'',
		'## Limitations (read before acting on any number above)',
		'',
		'- **Survivorship bias:** the symbol universe is today\'s Fyers master; names delisted during the window are absent from every list.',
		'- **Single regime window:** one stretch of market history; a different regime can reverse the ranking.',
		'- **Intraday only:** every trade is closed by 15:15 IST, as the live detectors are (Stock Momentum Breakout is INTRADAY since c83cd23); the multi-day ledger is OFF.',
		`- **${meta.resolution}-minute bars, 4 synthetic ticks per bar:** detectors that count ticks or build 3-minute candles see a coarser path than live.`,
		'- **Nifty detectors are universe-independent** and therefore identical across universes; only the equity detectors can differ.',
		'- **Anomaly-scanner promotions (Layer B) are not simulated** in any universe.',
		'- Thresholds were fixed in config/screener.json before this run; any change is a second, labelled run.',
	)
	return lines.join('\n') + '\n'
}

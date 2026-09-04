// ============================================================
// backtest/report/html.ts — self-contained HTML report
//
// No external scripts, no CDN, no fonts to fetch: the file opens from disk with
// nothing to re-run, which is what the goal doc asks for. Charts are inline SVG
// built here; hover behaviour is a small delegated handler at the bottom.
//
// CHART DECISIONS (and why):
//  - Per-detector equity curves are SMALL MULTIPLES, one per card, not 24 lines
//    on one axis. Beyond ~8 series a shared-axis line chart stops being
//    readable and colour stops carrying identity.
//  - Each equity curve is a single series, so it takes the primary hue and no
//    legend — the card title names it.
//  - The R histogram is POLARITY data (loss vs win around zero), so it uses the
//    diverging pair with a neutral zero rule, plus a text legend so the sign is
//    never carried by colour alone.
//  - Sample sufficiency uses the reserved status palette with an icon AND a
//    label, never colour alone.
//  - Never a dual axis anywhere. R and trade count are separate charts.
//
// Palette values are the validated reference instance; the two-arm diverging
// pair used here passes all six checks in both light and dark mode.
// ============================================================

interface HoldingStats {
	p25: number
	median: number
	p75: number
	max: number
}

interface PerfBlock {
	trades: number
	winRate: number | null
	expectancyR: number | null
	totalR: number
	maxDrawdownR: number
	bestTradeR: number | null
	worstTradeR: number | null
	avgWinR: number | null
	avgLossR: number | null
	profitFactor: number | null
	holdingMinutes: HoldingStats | null
	exitReasons: Record<string, number>
	tradesDeferredByLock: number
	equityCurve: Array<{ ts: number; cumR: number }>
	rDistribution: number[]
	sufficientSample: boolean
	topWinShare: number | null
	top3WinShare: number | null
	tailDependenceWarning: string | null
}

interface MetricRow {
	detectorId: string
	displayName: string
	tier: string
	bias: string
	exitBasis: string
	signalsUngated: number
	tradesGated: number
	gatePassRate: number
	rejections: Record<string, number>
	gated: PerfBlock
	ungated: PerfBlock
	sufficientSample: boolean
	sampleNote: string
}

export interface ReportPayload {
	generatedAt: string
	run: {
		sessions: number
		firstSession?: string
		lastSession?: string
		symbols: number
		barsReplayed: number
		ticksDispatched: number
		wallClockSeconds: number
	}
	assumptions: Record<string, unknown>
	metrics: MetricRow[]
	notBacktestable: Array<{
		id: string
		displayName: string
		tier: string
		reason?: string | undefined
	}>
	detectorErrors: Record<string, string>
	registry: Array<{ id: string; caveats?: string[] | undefined }>
	/** Rendered as an unmissable banner. Used to mark a synthetic-data run. */
	banner?: { title: string; body: string } | undefined
	misroutedSymbols?: string[] | undefined
}

// ── escaping ────────────────────────────────────────────────────────────────
const esc = (s: unknown): string =>
	String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')

const num = (v: number | null, digits = 2, dash = '—'): string =>
	v === null || !Number.isFinite(v) ? dash : v.toFixed(digits)

const pct = (v: number | null, digits = 0): string =>
	v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`

// ── charts ──────────────────────────────────────────────────────────────────

/**
 * Equity curve. Single series, 2px line, recessive zero baseline, no grid
 * clutter. Points are emitted as a data attribute for the hover layer rather
 * than as 200 DOM circles.
 */
const equityCurveSvg = (
	points: Array<{ ts: number; cumR: number }>,
	w: number,
	h: number,
	id: string,
): string => {
	if (points.length < 2) {
		return `<div class="empty">not enough trades to plot a curve</div>`
	}
	const pad = { t: 8, r: 8, b: 16, l: 34 }
	const iw = w - pad.l - pad.r
	const ih = h - pad.t - pad.b

	const ys = points.map((p) => p.cumR)
	let lo = Math.min(0, ...ys)
	let hi = Math.max(0, ...ys)
	if (hi === lo) {
		hi += 1
		lo -= 1
	}
	const padY = (hi - lo) * 0.08
	lo -= padY
	hi += padY

	const x = (i: number) => pad.l + (i / (points.length - 1)) * iw
	const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * ih

	const d = points
		.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.cumR).toFixed(1)}`)
		.join('')
	const zeroY = y(0).toFixed(1)

	// Serialised for the hover handler: index|xpx|ypx|cumR|ts
	const hoverData = points
		.map((p, i) => `${x(i).toFixed(1)},${y(p.cumR).toFixed(1)},${p.cumR},${p.ts}`)
		.join(';')

	return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img"
     aria-label="Cumulative R over ${points.length} trades, ending at ${num(points[points.length - 1]!.cumR)}R"
     data-hover="curve" data-points="${esc(hoverData)}" data-cid="${esc(id)}">
  <line class="axis" x1="${pad.l}" y1="${zeroY}" x2="${w - pad.r}" y2="${zeroY}"/>
  <text class="tick" x="${pad.l - 5}" y="${y(hi).toFixed(1)}" dy="0.7em" text-anchor="end">${num(hi, 1)}</text>
  <text class="tick" x="${pad.l - 5}" y="${zeroY}" dy="0.32em" text-anchor="end">0</text>
  <text class="tick" x="${pad.l - 5}" y="${y(lo).toFixed(1)}" dy="0" text-anchor="end">${num(lo, 1)}</text>
  <path class="series" d="${d}"/>
  <g class="crosshair" hidden><line class="ch-v" y1="${pad.t}" y2="${pad.t + ih}"/><circle class="ch-dot" r="4"/></g>
</svg>`
}

const R_BIN_EDGES = [-Infinity, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, 4, Infinity]

const binLabel = (i: number): string => {
	const a = R_BIN_EDGES[i]!
	const b = R_BIN_EDGES[i + 1]!
	if (a === -Infinity) return `< ${b}R`
	if (b === Infinity) return `> ${a}R`
	return `${a} to ${b}R`
}

/**
 * R distribution. Fixed bin edges so detectors are comparable to each other,
 * diverging colour on the sign of the bin, 2px surface gap between bars,
 * 4px rounded data-ends.
 */
const rHistogramSvg = (rs: number[], w: number, h: number): string => {
	if (rs.length === 0) return `<div class="empty">no gated trades</div>`

	const counts = new Array(R_BIN_EDGES.length - 1).fill(0) as number[]
	for (const r of rs) {
		for (let i = 0; i < counts.length; i++) {
			if (r >= R_BIN_EDGES[i]! && r < R_BIN_EDGES[i + 1]!) {
				counts[i]!++
				break
			}
		}
	}

	const pad = { t: 8, r: 8, b: 22, l: 26 }
	const iw = w - pad.l - pad.r
	const ih = h - pad.t - pad.b
	const maxC = Math.max(...counts, 1)
	const slot = iw / counts.length
	const gap = 2
	const bw = Math.max(2, slot - gap)

	const bars = counts
		.map((c, i) => {
			if (c === 0) return ''
			const bh = (c / maxC) * ih
			const bx = pad.l + i * slot + gap / 2
			const by = pad.t + ih - bh
			// Bin midpoint sign drives the arm: below 0 is a loss, at/above is a win.
			const loss = R_BIN_EDGES[i + 1]! <= 0
			const cls = loss ? 'bar-loss' : 'bar-win'
			return `<rect class="${cls}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="4"
        data-hover="bar" data-label="${esc(binLabel(i))}" data-count="${c}"><title>${esc(binLabel(i))}: ${c} trade${c === 1 ? '' : 's'}</title></rect>`
		})
		.join('')

	const zeroIdx = R_BIN_EDGES.indexOf(0)
	const zeroX = (pad.l + zeroIdx * slot).toFixed(1)

	return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Distribution of ${rs.length} trade R-multiples">
  <line class="axis" x1="${pad.l}" y1="${pad.t + ih}" x2="${w - pad.r}" y2="${pad.t + ih}"/>
  <line class="zeroline" x1="${zeroX}" y1="${pad.t}" x2="${zeroX}" y2="${pad.t + ih}"/>
  <text class="tick" x="${pad.l - 4}" y="${pad.t}" dy="0.7em" text-anchor="end">${maxC}</text>
  ${bars}
  <text class="tick" x="${pad.l}" y="${h - 6}">−2R</text>
  <text class="tick" x="${zeroX}" y="${h - 6}" text-anchor="middle">0</text>
  <text class="tick" x="${w - pad.r}" y="${h - 6}" text-anchor="end">+4R</text>
</svg>`
}

// ── pieces ──────────────────────────────────────────────────────────────────

const TIER_LABEL: Record<string, string> = {
	ACTIVE: 'Active',
	DORMANT: 'Dormant',
	ARCHIVED_A: 'Archived · Tier A',
	ARCHIVED_C: 'Archived · Tier C',
}

const statTile = (label: string, value: string, sub = ''): string =>
	`<div class="tile"><div class="tile-l">${esc(label)}</div><div class="tile-v">${esc(value)}</div>${sub ? `<div class="tile-s">${esc(sub)}</div>` : ''}</div>`

const sampleBadge = (ok: boolean, n: number): string =>
	ok
		? `<span class="badge good"><span class="ico" aria-hidden="true">●</span>Sufficient sample · ${n} trades</span>`
		: `<span class="badge warn"><span class="ico" aria-hidden="true">▲</span>Insufficient sample · ${n} trades</span>`

const perfRow = (label: string, b: PerfBlock, emphasis: boolean): string =>
	`<tr class="${emphasis ? 'emph' : ''}">
    <th scope="row">${esc(label)}</th>
    <td class="n">${b.trades}</td>
    <td class="n">${pct(b.winRate)}</td>
    <td class="n strong">${num(b.expectancyR, 3)}</td>
    <td class="n">${num(b.totalR, 1)}</td>
    <td class="n">${num(b.maxDrawdownR, 1)}</td>
    <td class="n">${num(b.profitFactor)}</td>
    <td class="n">${num(b.bestTradeR, 1)} / ${num(b.worstTradeR, 1)}</td>
    <td class="n">${b.holdingMinutes ? `${b.holdingMinutes.median}m` : '—'}</td>
  </tr>`

const detectorCard = (m: MetricRow, caveats: string[]): string => {
	const cls = m.sufficientSample ? 'card' : 'card low-sample'
	const rejEntries = Object.entries(m.rejections).sort((a, b) => b[1] - a[1])

	return `<section class="${cls}" id="d-${esc(m.detectorId)}">
  <header class="card-h">
    <div>
      <h3>${esc(m.displayName)}</h3>
      <div class="meta">
        <span class="tag t-${esc(m.tier)}">${esc(TIER_LABEL[m.tier] ?? m.tier)}</span>
        <span class="tag">${esc(m.bias)}</span>
        <span class="tag">exit: ${esc(m.exitBasis)}</span>
      </div>
    </div>
    ${sampleBadge(m.sufficientSample, m.tradesGated)}
  </header>

  <div class="kpis">
    ${statTile('Signals raised', String(m.signalsUngated), 'before the filter')}
    ${statTile('Passed the gate', String(m.tradesGated), pct(m.gatePassRate) + ' of signals')}
    ${statTile('Gated E[R]', num(m.gated.expectancyR, 3), 'what would have traded')}
    ${statTile('Ungated E[R]', num(m.ungated.expectancyR, 3), 'raw detector edge')}
  </div>

  <div class="table-scroll">
    <table class="perf">
      <caption>Gated is what the filter allowed through; ungated is every signal the detector raised. A large gap means the filter is doing a lot of work — for better or worse.</caption>
      <thead><tr><th></th><th class="n">Trades</th><th class="n">Win</th><th class="n">E[R]</th><th class="n">Total R</th><th class="n">Max DD</th><th class="n">PF</th><th class="n">Best / worst</th><th class="n">Median hold</th></tr></thead>
      <tbody>
        ${perfRow('Gated', m.gated, true)}
        ${perfRow('Ungated', m.ungated, false)}
      </tbody>
    </table>
  </div>

  <div class="charts">
    <figure>
      <figcaption>Cumulative R — gated</figcaption>
      ${equityCurveSvg(m.gated.equityCurve, 420, 130, m.detectorId + '-g')}
    </figure>
    <figure>
      <figcaption>Cumulative R — ungated</figcaption>
      ${equityCurveSvg(m.ungated.equityCurve, 420, 130, m.detectorId + '-u')}
    </figure>
    <figure>
      <figcaption>R distribution — ungated
        <span class="mini-legend"><span class="sw sw-loss"></span>loss<span class="sw sw-win"></span>win</span>
      </figcaption>
      ${rHistogramSvg(m.ungated.rDistribution, 420, 130)}
    </figure>
  </div>

  <dl class="facts">
    <div><dt>Exits (ungated)</dt><dd>${
			Object.entries(m.ungated.exitReasons)
				.map(([k, v]) => `${esc(k)} ${v}`)
				.join(' · ') || '—'
		}</dd></div>
    <div><dt>Deferred by circuit lock</dt><dd>${m.ungated.tradesDeferredByLock}</dd></div>
    <div><dt>Top trade / top 3 share of gains</dt><dd>${pct(m.ungated.topWinShare)} / ${pct(m.ungated.top3WinShare)}</dd></div>
    ${rejEntries.length ? `<div><dt>Gate rejections</dt><dd>${rejEntries.map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</dd></div>` : ''}
  </dl>

  <p class="note ${m.sufficientSample ? '' : 'note-warn'}">${esc(m.sampleNote)}</p>
  ${
		m.ungated.tailDependenceWarning
			? `<p class="note note-warn">${esc(m.ungated.tailDependenceWarning)}</p>`
			: ''
	}
  ${caveats.length ? `<ul class="caveats">${caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
</section>`
}

const rankedTable = (metrics: MetricRow[]): string => {
	const rows = metrics
		.map(
			(m) => `<tr class="${m.sufficientSample ? '' : 'low'}">
    <td class="name"><a href="#d-${esc(m.detectorId)}">${esc(m.displayName)}</a></td>
    <td><span class="tag t-${esc(m.tier)}">${esc(TIER_LABEL[m.tier] ?? m.tier)}</span></td>
    <td class="n">${m.signalsUngated}</td>
    <td class="n">${m.tradesGated}</td>
    <td class="n">${pct(m.gatePassRate)}</td>
    <td class="n">${pct(m.gated.winRate)}</td>
    <td class="n strong">${num(m.gated.expectancyR, 3)}</td>
    <td class="n">${num(m.ungated.expectancyR, 3)}</td>
    <td class="n">${num(m.gated.totalR, 1)}</td>
    <td class="n">${num(m.gated.maxDrawdownR, 1)}</td>
    <td>${m.sufficientSample ? '<span class="badge good sm"><span class="ico" aria-hidden="true">●</span>ok</span>' : '<span class="badge warn sm"><span class="ico" aria-hidden="true">▲</span>low sample</span>'}</td>
  </tr>`,
		)
		.join('')

	return `<table class="ranked">
  <caption>Ranked by <strong>gated</strong> expectancy in R — what would actually have traded. Ungated expectancy is shown alongside so over-suppression is visible. Insufficient-sample rows are grouped last and greyed; they are not ranked against the rest.</caption>
  <thead><tr>
    <th>Detector</th><th>Tier</th><th class="n">Signals</th><th class="n">Trades</th>
    <th class="n">Gate pass</th><th class="n">Win rate</th><th class="n">E[R] gated</th>
    <th class="n">E[R] ungated</th><th class="n">Total R</th><th class="n">Max DD</th><th>Sample</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`
}

/** Goal doc §5 — contradictions between backtest results and the pruning calls. */
/** Goal doc §5 — contradictions between backtest results and the pruning calls. */
const pruningReview = (metrics: MetricRow[]): string => {
	const confident = metrics.filter((m) => m.sufficientSample)

	const archivedButGood = confident.filter(
		(m) => m.tier.startsWith('ARCHIVED') && (m.gated.expectancyR ?? 0) > 0.1,
	)
	const activeButWeak = confident.filter(
		(m) => m.tier === 'ACTIVE' && (m.gated.expectancyR ?? 0) <= 0,
	)
	const dormantButGood = confident.filter(
		(m) => m.tier === 'DORMANT' && (m.gated.expectancyR ?? 0) > 0.1,
	)
	const unjudgeable = metrics.filter((m) => !m.sufficientSample)

	// Over-suppression: the raw detector looks profitable on a real sample, but
	// the filter blocks nearly all of it. That is a filter-calibration finding,
	// not a detector finding, and it is invisible if you only read gated.
	const overSuppressed = metrics.filter(
		(m) =>
			m.ungated.sufficientSample &&
			(m.ungated.expectancyR ?? 0) > 0.1 &&
			m.gatePassRate < 0.2 &&
			m.signalsUngated >= 20,
	)

	const list = (items: MetricRow[], empty: string, ungated = false) =>
		items.length === 0
			? `<p class="none">${esc(empty)}</p>`
			: `<ul>${items
					.map((m) =>
						ungated
							? `<li><a href="#d-${esc(m.detectorId)}">${esc(m.displayName)}</a> — ungated E[R] ${num(m.ungated.expectancyR, 3)} over ${m.ungated.trades} trades, but only ${pct(m.gatePassRate)} of its ${m.signalsUngated} signals passed the filter</li>`
							: `<li><a href="#d-${esc(m.detectorId)}">${esc(m.displayName)}</a> — gated E[R] ${num(m.gated.expectancyR, 3)} over ${m.tradesGated} trades, win rate ${pct(m.gated.winRate)}</li>`,
					)
					.join('')}</ul>`

	return `<section class="block">
  <h2>Pruning re-evaluation</h2>
  <p>Comparison against the Tier A/B/C/D decision, which was made on structural evidence
     only because no performance data existed at the time. <strong>This is a report, not an
     action</strong> — nothing is re-archived or re-activated without separate approval.
     Only sufficient-sample detectors are used to draw a conclusion.</p>

  <h3>Archived, but backtests positive — the archival may have been wrong</h3>
  ${list(archivedButGood, 'No archived detector clears a positive gated expectancy on a sufficient sample.')}

  <h3>Active, but backtests non-positive — survived pruning on structure alone</h3>
  ${list(activeButWeak, 'No active detector shows non-positive gated expectancy on a sufficient sample.')}

  <h3>Dormant and never archived, but backtests positive — revival candidates</h3>
  ${list(dormantButGood, 'No dormant detector clears a positive gated expectancy on a sufficient sample.')}

  <h3>Possibly over-suppressed by the filter</h3>
  <p>A positive raw edge on a real sample, but almost nothing reaching the gate. This is a
     finding about the <em>filter's calibration</em>, not about the detector — and it is
     invisible if you read only the gated column.</p>
  ${list(overSuppressed, 'No detector shows a positive ungated edge that the filter is largely blocking.', true)}

  <h3>Cannot be judged either way</h3>
  <p>${unjudgeable.length} detector(s) did not reach the gated sample threshold, so the backtest
     neither supports nor contradicts their tier. They keep their current status by default.</p>
</section>`
}

const notBacktestableBlock = (rows: ReportPayload['notBacktestable']): string => {
	if (rows.length === 0) return ''
	return `<section class="block">
  <h2>Not backtestable (${rows.length})</h2>
  <p>These detectors are excluded from every number above. Their edge cannot be
     reconstructed from historical OHLCV, so running them would produce an empty or
     meaningless sample rather than a result. Stated rather than hidden.</p>
  <ul class="reasons">
    ${rows
			.map(
				(r) =>
					`<li><strong>${esc(r.displayName)}</strong> <span class="tag t-${esc(r.tier)}">${esc(TIER_LABEL[r.tier] ?? r.tier)}</span><br>${esc(r.reason ?? '')}</li>`,
			)
			.join('')}
  </ul>
</section>`
}

const assumptionsBlock = (a: Record<string, unknown>): string => {
	const render = (v: unknown): string =>
		typeof v === 'object' && v !== null
			? Object.entries(v as Record<string, unknown>)
					.map(([k, vv]) => `${k}=${String(vv)}`)
					.join(', ')
			: String(v)
	return `<section class="block">
  <h2>Simulation assumptions</h2>
  <p><strong>On reading expectancy:</strong> these are momentum strategies, and the source spec
     they derive from expects a 25-30% win rate carried by winners running 10-20x initial risk.
     A low win rate is therefore not a defect, and expectancy in R — not win rate — is the metric
     to rank on. The flip side is that expectancy becomes a tail mean: each card reports what
     share of its gains came from its single best trade, and flags the figure when one trade
     supplied most of them. Trade count alone does not reveal that.</p>
  <p>Every number in this report is conditional on these. They are printed here rather
     than buried in code so a reader can judge the results against them.</p>
  <dl class="facts wide">
    ${Object.entries(a)
			.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(render(v))}</dd></div>`)
			.join('')}
  </dl>
</section>`
}

// ── page ────────────────────────────────────────────────────────────────────

export const renderHtmlReport = (payload: ReportPayload): string => {
	const { run, metrics } = payload
	const caveatsById = new Map(payload.registry.map((r) => [r.id, r.caveats ?? []]))
	const confident = metrics.filter((m) => m.sufficientSample)
	const totalSignals = metrics.reduce((s2, m) => s2 + m.signalsUngated, 0)
	const totalTrades = metrics.reduce((s2, m) => s2 + m.tradesGated, 0)
	const activeMetrics = metrics.filter((m) => m.tier === 'ACTIVE')

	// Merge trades from a set of detectors on entry time into one curve.
	const merge = (rows: MetricRow[], which: 'gated' | 'ungated') => {
		const pts = rows
			.flatMap((m) =>
				m[which].equityCurve.map((p, i) => ({ ts: p.ts, r: m[which].rDistribution[i] ?? 0 })),
			)
			.sort((a, b) => a.ts - b.ts)
		let cum = 0
		return pts.map((p) => {
			cum += p.r
			return { ts: p.ts, cumR: cum }
		})
	}

	const combinedGated = merge(
		activeMetrics.filter((m) => m.sufficientSample),
		'gated',
	)
	const combinedUngated = merge(activeMetrics, 'ungated')

	return `<title>Detector Backtest Report</title>
<style>
  .viz-root, body {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --plane: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --loss: #e34948;
    --win: #2a78d6;
    --zero: #f0efec;
    --good: #0ca30c;
    --warning: #fab219;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) body, :root:not([data-theme="light"]) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19; --plane: #0d0d0d;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
      --series-1: #3987e5; --loss: #e66767; --win: #3987e5; --zero: #383835;
      --good: #0ca30c; --warning: #fab219;
    }
  }
  :root[data-theme="dark"] body, :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19; --plane: #0d0d0d;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5; --loss: #e66767; --win: #3987e5; --zero: #383835;
    --good: #0ca30c; --warning: #fab219;
  }

  body {
    margin: 0; background: var(--plane); color: var(--text-primary);
    font: 14px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 18px; margin: 0 0 10px; }
  h3 { font-size: 15px; margin: 18px 0 6px; }
  p { color: var(--text-secondary); margin: 0 0 10px; }
  a { color: var(--series-1); }
  .sub { color: var(--muted); margin-bottom: 24px; }

  .block, .card {
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 10px; padding: 20px; margin: 0 0 20px;
  }
  .card.low-sample { opacity: 0.72; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap: 10px; margin-bottom: 24px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
  .tile-l { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  .tile-v { font-size: 21px; margin-top: 3px; }
  .tile-s { font-size: 11px; color: var(--muted); }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px,1fr)); gap: 8px; margin: 14px 0; }
  .kpis .tile { border-radius: 8px; padding: 9px 11px; }
  .kpis .tile-v { font-size: 17px; }

  .card-h { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .card-h h3 { margin: 0 0 5px; font-size: 16px; }
  .meta { display: flex; gap: 6px; flex-wrap: wrap; }
  .tag {
    font-size: 11px; padding: 2px 7px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--text-secondary);
  }
  .t-ACTIVE { border-color: var(--good); color: var(--good); }
  .t-ARCHIVED_A, .t-ARCHIVED_C { color: var(--muted); }

  .badge { font-size: 11.5px; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .badge.sm { font-size: 11px; }
  .badge .ico { font-size: 9px; }
  .badge.good { color: var(--good); }
  .badge.warn { color: var(--warning); }

  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); gap: 14px; margin: 6px 0 12px; }
  figure { margin: 0; }
  figcaption { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; }
  .chart { width: 100%; height: auto; display: block; overflow: visible; }
  .empty { font-size: 12px; color: var(--muted); padding: 34px 0; text-align: center; }

  .series { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .zeroline { stroke: var(--axis); stroke-width: 1; stroke-dasharray: 2 3; }
  .tick { fill: var(--muted); font-size: 9.5px; font-variant-numeric: tabular-nums; }
  .bar-loss { fill: var(--loss); }
  .bar-win { fill: var(--win); }
  .ch-v { stroke: var(--axis); stroke-width: 1; }
  .ch-dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }

  .mini-legend { display: inline-flex; align-items: center; gap: 5px; text-transform: none; letter-spacing: 0; }
  .sw { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  .sw-loss { background: var(--loss); }
  .sw-win { background: var(--win); margin-left: 6px; }

  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px,1fr)); gap: 6px 18px; margin: 10px 0 0; }
  .facts.wide { grid-template-columns: repeat(auto-fit, minmax(300px,1fr)); }
  .facts div { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--grid); padding: 4px 0; }
  .facts dt { color: var(--muted); font-size: 12px; }
  .facts dd { margin: 0; font-size: 12.5px; font-variant-numeric: tabular-nums; text-align: right; }

  .note { font-size: 12px; color: var(--text-secondary); margin: 10px 0 0; }
  .note-warn { color: var(--warning); }
  .caveats { margin: 10px 0 0; padding-left: 18px; font-size: 12px; color: var(--text-secondary); }
  .caveats li { margin-bottom: 5px; }
  .reasons { padding-left: 18px; font-size: 13px; color: var(--text-secondary); }
  .reasons li { margin-bottom: 10px; }
  .none { color: var(--muted); font-style: italic; }

  .table-scroll { overflow-x: auto; }
  table.perf { width: 100%; border-collapse: collapse; font-size: 12px; margin: 12px 0 4px; }
  table.perf caption { caption-side: bottom; text-align: left; color: var(--muted); font-size: 11.5px; margin-top: 6px; }
  table.perf th, table.perf td { padding: 6px 8px; border-bottom: 1px solid var(--grid); text-align: left; white-space: nowrap; }
  table.perf thead th { color: var(--muted); font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  table.perf th[scope="row"] { color: var(--text-secondary); font-weight: 600; }
  table.perf td.n, table.perf th.n { text-align: right; font-variant-numeric: tabular-nums; }
  table.perf tr.emph th[scope="row"] { color: var(--text-primary); }
  table.perf tr.emph td { background: color-mix(in oklab, var(--series-1) 6%, transparent); }
  table.ranked { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  table.ranked caption { caption-side: top; text-align: left; color: var(--text-secondary); font-size: 12px; margin-bottom: 10px; }
  table.ranked th, table.ranked td { padding: 7px 9px; border-bottom: 1px solid var(--grid); text-align: left; white-space: nowrap; }
  table.ranked th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  table.ranked td.n, table.ranked th.n { text-align: right; font-variant-numeric: tabular-nums; }
  table.ranked td.strong { font-weight: 600; }
  table.ranked tr.low td { color: var(--muted); }
  table.ranked td.name { white-space: normal; }

  .banner {
    background: var(--surface-1); border: 1px solid var(--warning);
    border-left: 4px solid var(--warning); border-radius: 8px;
    padding: 12px 16px; margin-bottom: 22px;
  }
  .banner strong { color: var(--warning); }
  .banner p { margin: 4px 0 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

  #tip {
    position: fixed; pointer-events: none; opacity: 0; transition: opacity .09s;
    background: var(--surface-1); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 7px;
    padding: 6px 9px; font-size: 12px; font-variant-numeric: tabular-nums;
    box-shadow: 0 4px 14px rgba(0,0,0,.14); z-index: 50; max-width: 240px;
  }
</style>

<div class="wrap viz-root">
  ${
		payload.banner
			? `<div class="banner"><strong>${esc(payload.banner.title)}</strong><p>${esc(payload.banner.body)}</p></div>`
			: ''
	}
  <h1>Detector Backtest Report</h1>
  <p class="sub">
    ${esc(run.sessions)} sessions${run.firstSession ? ` · ${esc(run.firstSession)} → ${esc(run.lastSession)}` : ''}
    · ${esc(run.symbols)} symbols · ${run.barsReplayed.toLocaleString()} bars
    · ${run.ticksDispatched.toLocaleString()} synthetic ticks
    · generated ${esc(payload.generatedAt)}
  </p>

  <div class="tiles">
    ${statTile('Detectors measured', String(metrics.length), `${payload.notBacktestable.length} not backtestable`)}
    ${statTile('Sufficient sample', String(confident.length), `of ${metrics.length} measured`)}
    ${statTile('Raw signals', totalSignals.toLocaleString(), 'ungated detector fires')}
    ${statTile('Gated trades', totalTrades.toLocaleString(), `${totalSignals ? ((totalTrades / totalSignals) * 100).toFixed(1) : '0'}% of signals passed`)}
    ${statTile('Replay time', `${run.wallClockSeconds}s`)}
  </div>

  <section class="block">
    <h2>Combined equity curve — active set</h2>
    <p>Cumulative R across the <strong>active</strong> detectors, trades merged in chronological
       order. Gated is restricted to detectors that also reached the sample threshold; ungated
       includes every active detector's raw signals. If the gated curve is flat or absent while
       the ungated curve moves, the filter is suppressing the active set rather than the
       detectors having nothing to say.</p>
    <div class="charts">
      <figure><figcaption>Gated — what would have traded</figcaption>${equityCurveSvg(combinedGated, 470, 210, 'combined-g')}</figure>
      <figure><figcaption>Ungated — raw active-set edge</figcaption>${equityCurveSvg(combinedUngated, 470, 210, 'combined-u')}</figure>
    </div>
  </section>

  <section class="block">
    <h2>Ranked comparison</h2>
    <div class="table-scroll">${rankedTable(metrics)}</div>
  </section>

  ${
		payload.misroutedSymbols && payload.misroutedSymbols.length
			? `<section class="block"><h2>Symbols excluded by a live routing bug</h2>
  <p>These equities are silently dropped by the live engine and therefore contribute
     nothing to the numbers above. <code>websocket.ts</code> decides whether a tick is an
     option with <code>symbol.includes('CE') || symbol.includes('PE')</code>, which is true
     for any company name containing those letters — so these are routed into the option
     branch and never receive a VWAP update, a candle, or a detector call. The replay
     reproduces the behaviour rather than correcting it, so the report describes the engine
     that actually runs. Fixing the routing and re-running would change every equity
     detector's numbers.</p>
  <ul class="reasons">${payload.misroutedSymbols.map((s2) => `<li><code>${esc(s2)}</code></li>`).join('')}</ul></section>`
			: ''
	}
  ${pruningReview(metrics)}
  ${notBacktestableBlock(payload.notBacktestable)}
  ${assumptionsBlock(payload.assumptions)}

  ${
		Object.keys(payload.detectorErrors).length
			? `<section class="block"><h2>Detector errors during replay</h2><ul class="reasons">${Object.entries(
					payload.detectorErrors,
				)
					.map(([k, v]) => `<li><strong>${esc(k)}</strong><br>${esc(v)}</li>`)
					.join('')}</ul></section>`
			: ''
	}

  <h2 style="margin:28px 0 14px">Per-detector detail</h2>
  ${metrics.map((m) => detectorCard(m, caveatsById.get(m.detectorId) ?? [])).join('')}
</div>

<div id="tip" role="status" aria-live="polite"></div>

<script>
// Hover layer. One delegated handler for every chart on the page:
//  - line charts get a crosshair plus the nearest point's value
//  - histogram bars get a per-bar tooltip
(function () {
  var tip = document.getElementById('tip');

  function show(html, x, y) {
    tip.innerHTML = html;
    tip.style.opacity = '1';
    var r = tip.getBoundingClientRect();
    var left = Math.min(x + 12, window.innerWidth - r.width - 8);
    var top = Math.max(8, y - r.height - 12);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hide() { tip.style.opacity = '0'; }

  document.querySelectorAll('svg[data-hover="curve"]').forEach(function (svg) {
    var raw = svg.getAttribute('data-points') || '';
    if (!raw) return;
    var pts = raw.split(';').map(function (s) {
      var p = s.split(',');
      return { x: +p[0], y: +p[1], r: +p[2], ts: +p[3] };
    });
    var group = svg.querySelector('.crosshair');
    var vline = svg.querySelector('.ch-v');
    var dot = svg.querySelector('.ch-dot');

    svg.addEventListener('mousemove', function (ev) {
      var box = svg.getBoundingClientRect();
      var vb = svg.viewBox.baseVal;
      // Map cursor position into viewBox units.
      var vx = ((ev.clientX - box.left) / box.width) * vb.width;
      var best = pts[0], bestD = Infinity;
      for (var i = 0; i < pts.length; i++) {
        var d = Math.abs(pts[i].x - vx);
        if (d < bestD) { bestD = d; best = pts[i]; }
      }
      group.hidden = false;
      vline.setAttribute('x1', best.x); vline.setAttribute('x2', best.x);
      dot.setAttribute('cx', best.x); dot.setAttribute('cy', best.y);
      var when = best.ts ? new Date(best.ts).toISOString().replace('T', ' ').slice(0, 16) : '';
      show('<strong>' + best.r.toFixed(3) + 'R</strong> cumulative' + (when ? '<br>' + when + ' UTC' : ''), ev.clientX, ev.clientY);
    });
    svg.addEventListener('mouseleave', function () { group.hidden = true; hide(); });
  });

  document.querySelectorAll('rect[data-hover="bar"]').forEach(function (bar) {
    bar.addEventListener('mousemove', function (ev) {
      var n = bar.getAttribute('data-count');
      show('<strong>' + n + '</strong> trade' + (n === '1' ? '' : 's') + '<br>' + bar.getAttribute('data-label'), ev.clientX, ev.clientY);
    });
    bar.addEventListener('mouseleave', hide);
  });
})();
</script>`
}

// ============================================================
// tests/niftyEmaShadow.test.ts — live EMA shadow detector vs the study engine
//
// Exercises the real src/detectors/shadow/niftyEmaShadow.ts, fed TICK BY TICK
// (backtest/replay/barToTicks: O→L→H→C / O→H→L→C per 1-minute bar) from real
// cached Nifty 1-minute history (tests/fixtures/nifty_1m_2026-06-01_to_06-24,
// 18 sessions), and requires the SAME trades and skip counts as the study
// engine (src/core/emaTrend.ts via backtest/emaTrend.ts) run on the 5-minute
// bars that backtest/data/store.aggregateBars derives from the same minutes.
// Engine-level fixtures (hand-checked EMA/VWAP, stop-first, gap fill, 15:15,
// >80 skip) are in tests/emaTrend.test.ts; the same functions run live.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import zlib from 'node:zlib'

import { aggregateBars } from '../backtest/data/store.js'
import { barToTicks } from '../backtest/replay/barToTicks.js'
import { runVariant, studyParams, studyVariants, toSessionBars, type Bar } from '../backtest/emaTrend.js'
import {
	NiftyEmaShadow,
	WARMUP_FULL_BARS,
	bucketStart,
	emaShadowEnabled,
	type BarStore,
	type ShadowWriter,
} from '../src/detectors/shadow/niftyEmaShadow.js'

const cfg = JSON.parse(fs.readFileSync('config/nifty_ema_study.json', 'utf8'))
const P = studyParams(cfg)
const VARIANTS = studyVariants(cfg)
const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync('tests/fixtures/nifty_1m_2026-06-01_to_06-24.json.gz')).toString()) as { sessions: string[]; bars: number[][] }
const M1 = fx.bars.map(([t, o, h, l, c]) => ({ t: t!, o: o!, h: h!, l: l!, c: c!, v: 0 }))
const IST = 330 * 60_000
const dayOf = (t: number) => new Date(t + IST).toISOString().slice(0, 10)
const WARMUP_SESSIONS = fx.sessions.slice(0, 3)
const TEST_SESSIONS = fx.sessions.slice(3)
const quiet = { log: () => {}, warn: () => {}, error: () => {} }

const memStore = (initial: Bar[]): BarStore & { bars: Bar[] } => {
	const s = { bars: initial.slice(), load: async () => s.bars.slice(), append: async (b: Bar) => void s.bars.push({ ...b }) }
	return s
}
const memWriter = (): ShadowWriter & { rows: Record<string, unknown>[] } => {
	const w = {
		rows: [] as Record<string, unknown>[],
		existingKeys: (day: string) => new Set(w.rows.filter((r) => r.sessionDate === day).map((r) => r.key as string)),
		append: (_day: string, r: object) => void w.rows.push(r as Record<string, unknown>),
	}
	return w
}

/** Run the live detector over the fixture: warm-up sessions preloaded as stored candles, test sessions as ticks. */
const runLive = async (sessions = TEST_SESSIONS, history = aggregateBars(M1.filter((b) => WARMUP_SESSIONS.includes(dayOf(b.t))), 5)) => {
	const store = memStore(history)
	const writer = memWriter()
	const ticksBars = M1.filter((b) => sessions.includes(dayOf(b.t)))
	const det = new NiftyEmaShadow(cfg, store, writer, quiet)
	await det.init(ticksBars[0]!.t)
	for (const b of ticksBars) for (const tk of barToTicks(b)) det.onTick(tk.price, tk.timestamp)
	return { writer, store }
}

/** The study engine on the same minutes: 5-minute bars from aggregateBars, warm-up + test sessions. */
const runStudy = () => {
	const bars = toSessionBars(aggregateBars(M1, 5), P.barMinutes)
	return VARIANTS.map((v) => ({ v, res: runVariant(bars, v, P) }))
}

test('PARITY: live shadow fed tick by tick == study engine on the same sessions (trades, prices, R, exit reasons, skips)', async () => {
	const { writer } = await runLive()
	const study = runStudy()
	let compared = 0
	const reasons = new Set<string>()
	for (const { v, res } of study) {
		// The final candle of the fixture (15:25 on the last day) never closes live; trades exit by 15:15, so nothing depends on it.
		const expected = res.trades
			.filter((t) => TEST_SESSIONS.includes(t.sessionDate) && t.reason !== 'SESSION_END_GAP')
			.map((t) => ({ entryTs: t.entryTs, exitTs: t.exitTs, side: t.side, entry: t.entry, exit: t.exit, stop: t.stop, r: t.r, reason: t.reason }))
		const live = writer.rows
			.filter((r) => r.type === 'trade' && (r.key as string).startsWith(`${v.id}:`))
			.map((r) => ({ entryTs: Date.parse(r.entryTime as string), exitTs: Date.parse(r.exitTime as string), side: r.side, entry: r.entryPrice, exit: r.exitPrice, stop: r.stop, r: r.r, reason: r.exitReason }))
			.sort((a, b) => a.entryTs - b.entryTs)
		assert.ok(expected.length >= 10, `${v.id}: fixture must exercise the variant (got ${expected.length} trades)`)
		assert.deepEqual(live, expected, `${v.id}: live trades differ from the study`)
		compared += expected.length
		for (const t of expected) reasons.add(t.reason)

		// skip counts per session, from the live daily summaries
		for (const d of TEST_SESSIONS) {
			const sl = res.signalLog.filter((s) => s.sessionDate === d)
			const exp = { positionOpen: sl.filter((s) => s.outcome === 'SKIP_OPEN').length, stopOver80: sl.filter((s) => s.outcome === 'SKIP_WIDE').length }
			const sum = writer.rows.find((r) => r.type === 'summary' && r.sessionDate === d) as { variants: Record<string, { skips: typeof exp; signals: number }> } | undefined
			assert.ok(sum, `summary written for ${d}`)
			assert.deepEqual(sum.variants[v.id]!.skips, exp, `${v.id} ${d} skips`)
			assert.equal(sum.variants[v.id]!.signals, sl.length, `${v.id} ${d} signals`)
		}
	}
	// the live path exercised every exit type
	for (const r of ['STOP', 'TRAIL', 'TIME']) assert.ok(reasons.has(r), `parity covers ${r} exits`)
	console.log(`[parity] ${compared} trades identical across ${TEST_SESSIONS.length} sessions; exit reasons ${[...reasons].join(',')}`)
})

test('PARITY covers both skip types live: position-open and stop > 80 points', async () => {
	const { writer } = await runLive()
	const sums = writer.rows.filter((r) => r.type === 'summary') as { variants: Record<string, { skips: { positionOpen: number; stopOver80: number } }> }[]
	const tot = (k: 'positionOpen' | 'stopOver80') => sums.reduce((a, s) => a + Object.values(s.variants).reduce((b, x) => b + x.skips[k], 0), 0)
	assert.ok(tot('positionOpen') > 0, 'some position-open skips')
	assert.ok(tot('stopOver80') > 0, 'some >80-point skips')
})

test('NO LOOK-AHEAD: records written after the first k sessions never change when later sessions arrive', async () => {
	const all = (await runLive()).writer.rows
	for (const k of [2, 7]) {
		const part = (await runLive(TEST_SESSIONS.slice(0, k))).writer.rows
		assert.ok(part.length > 0)
		assert.deepEqual(all.slice(0, part.length), part, `prefix after ${k} sessions`)
	}
})

test('15:15: TIME exits are written at the close of the candle ending 15:15 IST, and the daily summary with it', async () => {
	const { writer } = await runLive()
	const time = writer.rows.filter((r) => r.type === 'trade' && r.exitReason === 'TIME')
	assert.ok(time.length > 0)
	for (const r of time) assert.equal(new Date(Date.parse(r.exitTime as string) + IST).toISOString().slice(11, 16), '15:15')
	assert.equal(writer.rows.filter((r) => r.type === 'summary').length, TEST_SESSIONS.length)
})

test('WARM-UP: < 200 stored candles → rows flagged warmup_partial; ≥ 200 → not flagged', async () => {
	assert.equal(WARMUP_FULL_BARS, 200)
	const cold = (await runLive(TEST_SESSIONS.slice(0, 2), [])).writer.rows
	assert.ok(cold.length > 0)
	assert.ok(cold.every((r) => (r.data_quality as string[]).includes('warmup_partial')))
	const warm = (await runLive(TEST_SESSIONS.slice(0, 2))).writer.rows // 3 warm-up sessions = 225 candles
	assert.ok(warm.every((r) => !(r.data_quality as string[]).includes('warmup_partial')))
})

test('RESTART: a new instance on the same store and file writes no duplicate rows and keeps history', async () => {
	const sessions = TEST_SESSIONS.slice(0, 2)
	const history = aggregateBars(M1.filter((b) => WARMUP_SESSIONS.includes(dayOf(b.t))), 5)
	const store = memStore(history)
	const writer = memWriter()
	const ticks = M1.filter((b) => sessions.includes(dayOf(b.t))).flatMap(barToTicks)
	const half = Math.floor(ticks.length * 0.75) // restart during the second session
	const a = new NiftyEmaShadow(cfg, store, writer, quiet)
	await a.init(ticks[0]!.timestamp)
	for (const t of ticks.slice(0, half)) a.onTick(t.price, t.timestamp)
	const b = new NiftyEmaShadow(cfg, store, writer, quiet)
	await b.init(ticks[half]!.timestamp)
	for (const t of ticks.slice(half)) b.onTick(t.price, t.timestamp)
	const keys = writer.rows.map((r) => r.key as string)
	assert.equal(new Set(keys).size, keys.length, 'no duplicate keys after restart')
	const flagged = writer.rows.filter((r) => r.sessionDate === sessions[1] && Date.parse((r.exitTime as string) ?? '0') > ticks[half]!.timestamp)
	assert.ok(flagged.length > 0, 'the restarted session produced rows')
	for (const r of flagged) assert.ok((r.data_quality as string[]).includes('bars_incomplete'), 'rows after a mid-candle restart are flagged bars_incomplete')
})

test('CANDLES: 5-minute buckets aligned to 09:15 IST (as aggregateBars); ticks outside 09:15–15:30 ignored', async () => {
	const t0915 = Date.parse('2026-06-02T03:45:00Z')
	assert.equal(bucketStart(t0915 + 299_999, 5), t0915)
	assert.equal(bucketStart(t0915 + 300_000, 5), t0915 + 300_000)
	const store = memStore([])
	const det = new NiftyEmaShadow(cfg, store, memWriter(), quiet)
	await det.init(t0915)
	det.onTick(25_000, t0915 - 60_000) // 09:14 pre-open
	det.onTick(25_010, t0915 + 1_000)
	det.onTick(25_020, t0915 + 300_500) // closes the 09:15 candle
	await new Promise((r) => setImmediate(r))
	assert.deepEqual(store.bars, [{ t: t0915, o: 25_010, h: 25_010, l: 25_010, c: 25_010 }])
})

test('KILL SWITCH and isolation: EMA_SHADOW_ENABLED=false disables; the module imports no alert, filter or trade code', () => {
	assert.equal(emaShadowEnabled(undefined), true)
	assert.equal(emaShadowEnabled('true'), true)
	assert.equal(emaShadowEnabled('false'), false)
	const src = fs.readFileSync('src/detectors/shadow/niftyEmaShadow.ts', 'utf8')
	const imports = [...src.matchAll(/^import [\s\S]*?from '([^']+)'/gm)].map((m) => m[1])
	assert.deepEqual(imports.sort(), ['../../core/emaTrend.js', 'node:fs', 'node:path'])
	const code = src.replace(/\/\/.*$/gm, '') // comments may say "no Fyers calls"; code must not reference any of these
	assert.doesNotMatch(code, /sendTelegramAlert|runJaneStreetFilter|registerTrade|positionTracker|fyers|telegraf|pool\.query/i)
})

// ============================================================
// backtest/bt6m/liveSession.ts — one session through the LIVE pipeline (6-month backtest, PR scope)
//
// docs/studies/backtest-6m/PREREGISTRATION.md §3 and §6. Mirrors the live tick handler in
// src/ingestion/websocket.ts (`tickEmitter.on('processTick')`), step for step and with the live modules:
//   0. positionTracker.notePrice + processTick            (the live tracker, unchanged: exits, R, 15:15 TIME)
//   1. Nifty: onNiftyTick → updateNiftyBias(getLastNiftyVwap) → feedTick → EV-shadow onTick → the 5 Nifty
//      detectors, in the live order
//   3. equities on the day's list: updateSessionVwap (session + last-trade-time gates) → feedTick →
//      EV-shadow onTick → StockMomentumBreakout + VolatilityContraction (Promise.all, as live)
// Every detector fire goes through the live sendTelegramAlert body: runAlertPipeline (filter, computeTradeLevels,
// geometry guard, capital sizing, duplicate / one-per-symbol-side claims, the daily alert cap, EV shadow),
// with in-memory Redis (backtest/core/memoryRedis), in-memory paper_trades (./memoryPg) and an in-memory EV-shadow
// store. Nothing is sent: sendChannel / sendAdmin are captured. The signals row is built with the live
// newSignalDraft / buildSignalRow.
//
// Two backtest-only rules, pre-registered (PREREGISTRATION.md, amendment 1):
//   - SAME-BAR RULE: if an open position's stop AND target both lie inside a bar, that bar's synthetic ticks take
//     the adverse extreme first (LONG: O→L→H→C, SHORT: O→H→L→C), so the stop is reached before the target.
//   - LEVEL TICKS (tracker only): between two consecutive prices of a symbol, a tick AT each open position's stop
//     or target that lies strictly between them is given to the tracker first. Live, real ticks cross a level
//     close to it; with 4 synthetic ticks per bar the tracker would otherwise fill at the bar's extreme. A gap
//     through a level (no tick between) still fills at the first price beyond it, as live.
// ============================================================

import crypto from 'node:crypto'
import type { IDetector, TickData } from '../../src/core/types.js'
import { runJaneStreetFilter, CONFIRMATION_THRESHOLD } from '../../src/detectors/janeStreetFilter.js'
import { backtestSink, type AlertPayload } from '../../src/workers/telegramWorker.js'
import { runAlertPipeline, type PipelineDeps } from '../../src/workers/alertPipeline.js'
import { COMPARE_AND_DELETE_LUA, COMPARE_AND_SET_LUA, parseMaxAlertsPerDay } from '../../src/workers/alertPolicy.js'
import { newSignalDraft, buildSignalRow, type SignalRow } from '../../src/db/signalRecord.js'
import { positionTracker, type OpenPosition } from '../../src/core/positionTracker.js'
import { EvShadowTracker, setEvShadow, getEvShadow, type EvShadowStore, type ShadowInsert, type ShadowExitReason } from '../../src/core/evShadow.js'
import { getLastNiftyVwap, onNiftyTick, resetNiftyMinuteState } from '../../src/core/niftyMinuteState.js'
import { clearSymbolSources, getSymbolSource, registerDailySources } from '../../src/core/symbolSource.js'
import { updateSessionVwap, updateNiftyBias } from '../../src/utils/vwapUtils.js'
import { feedTick, resetCandles } from '../../src/utils/candleAggregator.js'
import { resetStructure } from '../../src/utils/marketStructure.js'
import { pruneStaleStrikes } from '../../src/utils/optionUtils.js'
import { resetRegimeState } from '../../src/utils/regimeDetector.js'
import { resetDiagnostics } from '../../src/core/detectorDiagnostics.js'
import { redisClient } from '../../src/config/redis.js'
import { OiLiquiditySweepDetector } from '../../src/detectors/oiLiquiditySweepDetector.js'
import { DeltaHedgingPressureDetector } from '../../src/detectors/deltahedgingpressuredetector.js'
import { NiftyTrendPulseDetector } from '../../src/detectors/v2/niftyTrendPulseDetector.js'
import { NiftyVwapReclaimDetector } from '../../src/detectors/v2/niftyVwapReclaimDetector.js'
import { NiftyOpeningRangeExplosionDetector } from '../../src/detectors/v2/niftyOpeningRangeExplosionDetector.js'
import { StockMomentumBreakoutDetector } from '../../src/detectors/v2/stockMomentumBreakoutDetector.js'
import { VolatilityContraction } from '../../src/detectors/v2/high_alpha/VolatilityContraction.js'
import { NIFTY_SYMBOL } from '../config.js'
import { getMemoryRedis } from '../core/memoryRedis.js'
import { setVirtualNow, istEpoch } from '../core/clock.js'
import { mergeChronologically, assertChronological, looksCircuitLocked, TICKS_PER_BAR } from '../replay/barToTicks.js'
import type { Bar } from '../data/store.js'
import type { MemoryPaperTrades, PaperRow } from './memoryPg.js'

// ── pure helpers (tested) ────────────────────────────────────────────────────

const STEP_MS = 60_000 / TICKS_PER_BAR

/** The 4 synthetic ticks of a bar: barToTicks' path, except when `adverseFirst` forces the stop side first. */
export const barPath = (bar: Bar, adverseFirst: 'LONG' | 'SHORT' | null): TickData[] => {
	const bullish = bar.c >= bar.o
	const path =
		adverseFirst === 'LONG' ? [bar.o, bar.l, bar.h, bar.c]
		: adverseFirst === 'SHORT' ? [bar.o, bar.h, bar.l, bar.c]
		: bullish ? [bar.o, bar.l, bar.h, bar.c]
		: [bar.o, bar.h, bar.l, bar.c]
	const v = Math.max(0, bar.v) / TICKS_PER_BAR
	return path.map((price, i) => ({ price, volume: v, timestamp: bar.t + i * STEP_MS }))
}

type Lv = Pick<OpenPosition, 'side' | 'stopLoss' | 'target'>

/**
 * Same-bar rule (amendment 1, tie-break amendment 3): of the positions whose stop AND target both lie within
 * [lo, hi], the side of the one whose stop is nearest `ref` (the bar's open, or the current price mid-bar);
 * null if there is none.
 */
export const stopFirstSide = (lo: number, hi: number, ref: number, open: Lv[]): 'LONG' | 'SHORT' | null => {
	let best: Lv | null = null
	for (const p of open) {
		const inside = (x: number) => x >= lo && x <= hi
		if (!inside(p.stopLoss) || !inside(p.target)) continue
		if (!best || Math.abs(p.stopLoss - ref) < Math.abs(best.stopLoss - ref)) best = p
	}
	return best?.side ?? null
}
export const sameBarSide = (bar: Bar, open: Lv[]): 'LONG' | 'SHORT' | null => stopFirstSide(bar.l, bar.h, bar.o, open)

/**
 * Same-bar rule for a position opened at the bar's OPEN tick (review finding 1): the two extremes still ahead
 * (path[1], path[2]) are reordered so the adverse one comes first when a position has both levels inside the rest
 * of the bar. Returns a new path; ticks already dispatched and the closing tick never move.
 */
export const reorderAfterOpen = (path: number[], open: Lv[]): number[] => {
	if (path.length !== 4) return path
	const rest = path.slice(1)
	const side = stopFirstSide(Math.min(...rest), Math.max(...rest), path[0]!, open)
	if (!side) return path
	const [a, b] = [path[1]!, path[2]!]
	const lowFirst = side === 'LONG'
	return lowFirst ? [path[0]!, Math.min(a, b), Math.max(a, b), path[3]!] : [path[0]!, Math.max(a, b), Math.min(a, b), path[3]!]
}

/** Level ticks between two consecutive prices: every open level strictly between them, in the order price passes them. */
export const levelsBetween = (from: number, to: number, open: Pick<OpenPosition, 'stopLoss' | 'target'>[]): number[] => {
	if (from === to) return []
	const lo = Math.min(from, to)
	const hi = Math.max(from, to)
	const lv = new Set<number>()
	for (const p of open) for (const x of [p.stopLoss, p.target]) if (x > lo && x < hi) lv.add(x)
	return [...lv].sort((a, b) => (to > from ? a - b : b - a))
}

// ── in-memory EV-shadow store (the EvShadowStore contract, src/core/evShadow.ts) ──────────────────

export interface EvShadowRow extends ShadowInsert {
	id: number
	status: 'OPEN' | 'CLOSED' | 'UNRESOLVED'
	exit?: { price: number; ts: number; reason: ShadowExitReason; r: number | null }
}
export const memoryEvShadowStore = (): EvShadowStore & { rows: EvShadowRow[] } => {
	const rows: EvShadowRow[] = []
	return {
		rows,
		insert: async (row) => {
			const r: EvShadowRow = { ...row, id: rows.length + 1, status: 'OPEN' }
			rows.push(r)
			return r.id
		},
		close: async (id, exit) => {
			const r = rows.find((x) => x.id === id)
			if (r && r.status === 'OPEN') Object.assign(r, { status: 'CLOSED', exit })
		},
		loadOpen: async () => [],
		markUnresolved: async () => 0,
		countToday: async () => 0,
	}
}

// ── the session ──────────────────────────────────────────────────────────────

export interface LiveSessionInputs {
	sessionDate: string
	/** 1-minute bars of this session per symbol; must include NIFTY_SYMBOL. */
	barsBySymbol: Map<string, Bar[]>
	/** The day's list (dw-3 entries) — the subscribed equities and their promotion sources. */
	entries: { symbol: string; group: 'core' | 'rotating'; pick?: 'score' | 'turnover' }[]
	paper: MemoryPaperTrades
	config: { capitalBase: number; capitalBehavior: string }
	/** TESTS ONLY: replace the live equity stack / the filter, to drive a known fire end to end. */
	testHooks?: { equityStack?: (symbol: string) => IDetector[]; runFilter?: PipelineDeps['runFilter'] }
}

export interface LiveSessionResult {
	sessionDate: string
	signals: SignalRow[]
	paper: PaperRow[]
	evShadow: EvShadowRow[]
	channelMessages: number
	adminMessages: number
	stillOpenAtEnd: number
	stillOpenSymbols: string[]
	errors: string[]
	barsReplayed: number
	ticksDispatched: number
	missingSymbols: string[]
}

type TrackerInternals = {
	openPositions: Map<string, OpenPosition[]>
	lastPrice: Map<string, unknown>
	tickQueues: Map<string, unknown>
	closingIds: Set<string>
	lastPnlPublishTime: Map<string, number>
}
/** Live restarts the process each morning; the singleton tracker is emptied the same way between sessions. */
export const resetTracker = (): void => {
	const t = positionTracker as unknown as TrackerInternals
	t.openPositions.clear()
	t.lastPrice.clear()
	t.tickQueues.clear()
	t.closingIds.clear()
	t.lastPnlPublishTime.clear()
}
export const openOf = (symbol: string): OpenPosition[] => (positionTracker as unknown as TrackerInternals).openPositions.get(symbol) ?? []
const openCount = (): number => [...(positionTracker as unknown as TrackerInternals).openPositions.values()].reduce((n, l) => n + l.length, 0)

/** One price for the LIVE tracker: first a tick at each open level strictly between the previous price and this one. */
export const trackerStep = async (symbol: string, price: number, ts: number, lastPx: Map<string, number>): Promise<void> => {
	const prev = lastPx.get(symbol)
	if (prev !== undefined) for (const lv of levelsBetween(prev, price, openOf(symbol))) await positionTracker.processTick(symbol, { price: lv, volume: 0, timestamp: ts })
	await positionTracker.processTick(symbol, { price, volume: 0, timestamp: ts })
	lastPx.set(symbol, price)
}

/**
 * The live sendTelegramAlert dependencies (src/workers/telegramWorker.ts liveDeps), with the in-memory stores:
 * the real filter, the real position tracker, the alert/claim stores on (memory) redisClient with the live Lua,
 * EV shadow through getEvShadow(). Telegram is replaced by counters. `runFilter` can be overridden by tests only.
 */
export const livePipelineDeps = (o: {
	config: { capitalBase: number; capitalBehavior: string }
	onChannel: () => void
	onAdmin: () => void
	runFilter?: PipelineDeps['runFilter']
}): PipelineDeps => ({
	runFilter: o.runFilter ?? ((data) => runJaneStreetFilter(data, data.detectorName)),
	getTracker: async () => positionTracker,
	getAlertStore: async () => redisClient as never,
	getClaimStore: async () => ({
		get: (k) => redisClient.get(k),
		set: (k, v, opt) => redisClient.set(k, v, opt) as Promise<string | null>,
		compareAndSet: async (k, expected, next, ttl) =>
			Number(await redisClient.eval(COMPARE_AND_SET_LUA, { keys: [k], arguments: [expected, next, String(ttl)] })) === 1,
		compareAndDelete: async (k, expected) =>
			Number(await redisClient.eval(COMPARE_AND_DELETE_LUA, { keys: [k], arguments: [expected] })) === 1,
	}),
	sendChannel: async () => o.onChannel(),
	sendAdmin: async () => o.onAdmin(),
	onEvRejected: (data, decision, signalId) => getEvShadow()?.record(data, decision, signalId),
	now: () => Date.now(),
	config: {
		shadowMode: process.env.SHADOW_MODE === 'true',
		maxAlertsPerDay: parseMaxAlertsPerDay(process.env.TELEGRAM_MAX_ALERTS_PER_DAY),
		capitalBase: o.config.capitalBase,
		capitalBehavior: o.config.capitalBehavior,
		hasAdmin: true,
	},
})

export const runLiveSession = async (inp: LiveSessionInputs): Promise<LiveSessionResult> => {
	if (process.env.BACKTEST_MODE !== 'true') throw new Error('BACKTEST_MODE=true is required')
	const { sessionDate, barsBySymbol } = inp
	const universe = inp.entries.map((e) => e.symbol)
	const universeSet = new Set(universe)
	const errors: string[] = []

	// ── 1. blank slate, as a fresh live boot on a new day ────────────────────
	getMemoryRedis().flushAll()
	resetRegimeState()
	resetDiagnostics()
	resetNiftyMinuteState()
	pruneStaleStrikes([])
	for (const s of [...universe, NIFTY_SYMBOL]) {
		resetCandles(s)
		resetStructure(s)
	}
	resetTracker()
	clearSymbolSources()
	registerDailySources(universe, inp.entries, null)
	const firstPaperRow = inp.paper.rows.length
	setVirtualNow(istEpoch(sessionDate, 9 * 60))
	const evStore = memoryEvShadowStore()
	const ev = new EvShadowTracker(evStore, () => Date.now(), { log: () => {}, warn: () => {} })
	await ev.init()
	setEvShadow(ev)

	// Live constructs the Nifty singletons once per process (one process per day) and one equity stack per symbol.
	const niftyStack: IDetector[] = [
		new NiftyOpeningRangeExplosionDetector(),
		new NiftyTrendPulseDetector(),
		new NiftyVwapReclaimDetector(),
		new OiLiquiditySweepDetector(),
		new DeltaHedgingPressureDetector(),
	]
	const router = new Map<string, IDetector[]>()
	for (const s of universe) router.set(s, inp.testHooks?.equityStack?.(s) ?? [new StockMomentumBreakoutDetector(s), new VolatilityContraction(s)])

	// ── 2. the live alert path ───────────────────────────────────────────────
	let channelMessages = 0
	let adminMessages = 0
	const shadowMode = process.env.SHADOW_MODE === 'true'
	const deps = livePipelineDeps({
		config: inp.config,
		onChannel: () => void channelMessages++,
		onAdmin: () => void adminMessages++,
		...(inp.testHooks?.runFilter ? { runFilter: inp.testHooks.runFilter } : {}),
	})
	const signals: SignalRow[] = []
	const pending: AlertPayload[] = []
	backtestSink.collect = (payload) => {
		pending.push({ ...payload })
	}
	const drain = async () => {
		while (pending.length) {
			const data = pending.shift()!
			const draft = newSignalDraft(data, { signalId: crypto.randomUUID(), firedAt: Date.now(), shadowMode })
			try {
				await runAlertPipeline(data, deps, draft)
			} catch (err) {
				errors.push(`pipeline ${data.symbol}: ${(err as Error)?.message ?? err}`)
			}
			signals.push(buildSignalRow(draft, { threshold: CONFIRMATION_THRESHOLD, promotionSource: getSymbolSource(data.symbol) }))
		}
	}
	const analyze = async (d: IDetector, tick: TickData) => {
		try {
			await d.analyze(tick)
		} catch (err) {
			errors.push(`${d.constructor.name}: ${(err as Error)?.message ?? err}`)
		}
	}

	// ── 3. the replay loop ───────────────────────────────────────────────────
	// Merged at TICK level by (timestamp, symbol) — review finding 5: merging whole bars let a symbol sorting
	// after Nifty see Nifty's t+45 s close while handling its own t+0 tick. A bar's price path is fixed when its
	// first tick is reached (same-bar rule from the positions open then), and re-ordered once if a position opens
	// on the open tick (reorderAfterOpen).
	const bars = mergeChronologically(barsBySymbol)
	assertChronological(bars)
	const stream: { symbol: string; bar: Bar; i: number; ts: number }[] = []
	for (const { symbol, bar } of bars) {
		if (symbol !== NIFTY_SYMBOL && !universeSet.has(symbol)) continue
		for (let i = 0; i < TICKS_PER_BAR; i++) stream.push({ symbol, bar, i, ts: bar.t + i * STEP_MS })
	}
	stream.sort((a, b) => a.ts - b.ts || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
	const paths = new Map<string, number[]>()
	const lastPx = new Map<string, number>()
	const squareOffAt = istEpoch(sessionDate, 15 * 60 + 15)
	let ticksDispatched = 0

	try {
		for (const { symbol, bar, i, ts } of stream) {
			const isNifty = symbol === NIFTY_SYMBOL
			if (i === 0) paths.set(symbol, barPath(bar, sameBarSide(bar, openOf(symbol))).map((t) => t.price))
			const price = paths.get(symbol)![i]!
			const volume = Math.max(0, bar.v) / TICKS_PER_BAR
			const openBefore = openOf(symbol).length
			setVirtualNow(ts)
			ticksDispatched++
			// The 15:15 timer (every 5 s live): from 15:15, close at each symbol's last price.
			if (ts >= squareOffAt) await positionTracker.squareOffSweep(ts)
			positionTracker.notePrice(symbol, price, ts)
			if (!isNifty && !(volume > 0)) {
				lastPx.set(symbol, price)
				continue // live drops zero-volume equity ticks after noting the price
			}
			const liveTick: TickData = { price, volume: isNifty ? 1 : volume, timestamp: ts }
			// Gap-through rule (amendment 3): a bar's OPEN goes to the tracker as it is — no level tick between the
			// previous price and the open — so a candle opening beyond a stop or target fills at the open.
			if (i === 0) lastPx.delete(symbol)
			// Circuit-lock bars (zero range with volume) don't fill a stop: the tracker skips them (PREREGISTRATION §3).
			if (!looksCircuitLocked(bar)) await trackerStep(symbol, price, ts, lastPx)
			else lastPx.set(symbol, price)

			if (isNifty) {
				// Live doesn't await onNiftyTick (websocket.ts), so the bias reads the PREVIOUS reference on a
				// minute-closing tick; the promise is awaited only after the tick, for determinism (finding 7d).
				const minute = onNiftyTick(price, ts)
				const ref = getLastNiftyVwap()
				if (ref > 0) await updateNiftyBias(price, ref)
				feedTick(NIFTY_SYMBOL, price, liveTick.volume)
				await getEvShadow()?.onTick(NIFTY_SYMBOL, price, ts).catch(() => {})
				for (const d of niftyStack) {
					await analyze(d, liveTick)
					await drain()
				}
				await minute.catch((e) => errors.push(`onNiftyTick: ${(e as Error)?.message ?? e}`))
			} else {
				await updateSessionVwap(symbol, price, liveTick.volume, ts, Math.floor(ts / 1000))
				feedTick(symbol, price, liveTick.volume)
				await getEvShadow()?.onTick(symbol, price, ts).catch(() => {})
				await Promise.all((router.get(symbol) ?? []).map((d) => analyze(d, liveTick)))
				await drain()
			}
			// A position opened on this bar's open tick: the same-bar rule for the rest of this bar (finding 1).
			if (i === 0 && openOf(symbol).length > openBefore) paths.set(symbol, reorderAfterOpen(paths.get(symbol)!, openOf(symbol)))
		}
	} finally {
		backtestSink.collect = null
		setEvShadow(null)
	}

	return {
		sessionDate,
		signals,
		paper: inp.paper.rows.slice(firstPaperRow),
		evShadow: evStore.rows,
		channelMessages,
		adminMessages,
		stillOpenAtEnd: openCount(),
		stillOpenSymbols: [...(positionTracker as unknown as TrackerInternals).openPositions].filter(([, l]) => l.length).map(([s]) => s),
		errors,
		barsReplayed: bars.length,
		ticksDispatched,
		missingSymbols: universe.filter((s) => !barsBySymbol.has(s)),
	}
}

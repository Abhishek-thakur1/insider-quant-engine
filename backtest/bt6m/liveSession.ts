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
import { mergeChronologically, assertChronological, TICKS_PER_BAR } from '../replay/barToTicks.js'
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

/** Same-bar rule: the side whose stop must come first in this bar, or null (no position has both levels inside it). */
export const sameBarSide = (bar: Bar, open: Pick<OpenPosition, 'side' | 'stopLoss' | 'target'>[]): 'LONG' | 'SHORT' | null => {
	for (const p of open) {
		const inBar = (x: number) => x >= bar.l && x <= bar.h
		if (inBar(p.stopLoss) && inBar(p.target)) return p.side
	}
	return null
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
}

export interface LiveSessionResult {
	sessionDate: string
	signals: SignalRow[]
	paper: PaperRow[]
	evShadow: EvShadowRow[]
	channelMessages: number
	adminMessages: number
	stillOpenAtEnd: number
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
	for (const s of universe) router.set(s, [new StockMomentumBreakoutDetector(s), new VolatilityContraction(s)])

	// ── 2. the live alert path ───────────────────────────────────────────────
	let channelMessages = 0
	let adminMessages = 0
	const shadowMode = process.env.SHADOW_MODE === 'true'
	const deps = livePipelineDeps({
		config: inp.config,
		onChannel: () => void channelMessages++,
		onAdmin: () => void adminMessages++,
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
	const stream = mergeChronologically(barsBySymbol)
	assertChronological(stream)
	const lastPx = new Map<string, number>()
	const squareOffAt = istEpoch(sessionDate, 15 * 60 + 15)
	let ticksDispatched = 0

	const trackerTick = (symbol: string, price: number, ts: number) => trackerStep(symbol, price, ts, lastPx)

	try {
		for (const { symbol, bar } of stream) {
			const isNifty = symbol === NIFTY_SYMBOL
			if (!isNifty && !universeSet.has(symbol)) continue
			const ticks = barPath(bar, sameBarSide(bar, openOf(symbol)))
			for (const t of ticks) {
				setVirtualNow(t.timestamp)
				ticksDispatched++
				// The 15:15 timer (every 5 s live): from 15:15, close at each symbol's last price.
				if (t.timestamp >= squareOffAt) await positionTracker.squareOffSweep(t.timestamp)
				positionTracker.notePrice(symbol, t.price, t.timestamp)
				if (!isNifty && !(t.volume > 0)) {
					lastPx.set(symbol, t.price)
					continue // live drops zero-volume equity ticks after noting the price
				}
				const liveTick: TickData = { price: t.price, volume: isNifty ? 1 : t.volume, timestamp: t.timestamp }
				await trackerTick(symbol, t.price, t.timestamp)

				if (isNifty) {
					await onNiftyTick(t.price, t.timestamp)
					const ref = getLastNiftyVwap()
					if (ref > 0) await updateNiftyBias(t.price, ref)
					feedTick(NIFTY_SYMBOL, t.price, liveTick.volume)
					await getEvShadow()?.onTick(NIFTY_SYMBOL, t.price, t.timestamp).catch(() => {})
					for (const d of niftyStack) {
						await analyze(d, liveTick)
						await drain()
					}
					continue
				}
				await updateSessionVwap(symbol, t.price, liveTick.volume, t.timestamp, Math.floor(t.timestamp / 1000))
				feedTick(symbol, t.price, liveTick.volume)
				await getEvShadow()?.onTick(symbol, t.price, t.timestamp).catch(() => {})
				await Promise.all((router.get(symbol) ?? []).map((d) => analyze(d, liveTick)))
				await drain()
			}
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
		errors,
		barsReplayed: stream.length,
		ticksDispatched,
		missingSymbols: universe.filter((s) => !barsBySymbol.has(s)),
	}
}

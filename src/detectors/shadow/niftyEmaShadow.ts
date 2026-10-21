// ============================================================
// detectors/shadow/niftyEmaShadow.ts — Nifty EMA trend study, run live in SHADOW
//
// Owner spec 2026-10-21. Shadow only: no Telegram, no JaneStreetFilter, no
// paper_trades rows, no migration, no Fyers calls. It builds 5-minute Nifty 50
// candles from the tick stream and, on every candle close, re-runs the SAME
// pure engine as the study (src/core/emaTrend.ts, parameters from
// config/nifty_ema_study.json via studyParams/studyVariants) over
// stored history + today's candles. A trade is written once its exit is final
// (STOP, STOP_GAP, TRAIL or TIME on a closed candle); the engine is causal, so
// a later candle can never change it. tests/niftyEmaShadow.test.ts replays
// cached sessions tick by tick and requires the same trades as the study.
//
// Warm-up: exactly the study's — EMAs run continuously over every stored
// candle (SMA-seeded), the VWAP proxy resets each session. History comes only
// from the engine's own closed candles kept in Redis (no REST). Rows are
// flagged warmup_partial while fewer than WARMUP_FULL_BARS candles precede the
// session (the study had years; 200 bars leave an EMA21 seed weight < 1e-8).
//
// Output: one JSONL file per IST day (trades + a daily summary) and a daily
// summary log line at the 15:15 candle. Kill switch: EMA_SHADOW_ENABLED=false.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

import {
	runVariant,
	studyParams,
	studyVariants,
	toSessionBars,
	type Bar,
	type EmaStudyConfig,
	type StudyParams,
	type VariantSpec,
} from '../../core/emaTrend.js'

export const EMA_SHADOW_BARS_KEY = 'ema_shadow:nifty:bars5' // Redis list of closed 5-min candles (JSON Bar), kept across sessions
export const MAX_STORED_BARS = 1500 // ≈ 20 sessions
export const WARMUP_FULL_BARS = 200

const IST_MS = 330 * 60_000
const DAY_MS = 86_400_000
const SESSION_OPEN_MIN = 9 * 60 + 15
const SESSION_CLOSE_MIN = 15 * 60 + 30
const PARTIAL_TOLERANCE_MS = 5_000 // a first tick later than this into its candle means the candle's start was missed

/** Bucket start (epoch ms) of the bar containing ts — the same alignment as backtest aggregateBars. */
export const bucketStart = (ts: number, minutes: number): number => {
	const ist = ts + IST_MS
	const dayStart = ist - (ist % DAY_MS)
	const minOfDay = Math.floor((ist - dayStart) / 60_000)
	const bucket = Math.floor((minOfDay - SESSION_OPEN_MIN) / minutes)
	return dayStart - IST_MS + (SESSION_OPEN_MIN + bucket * minutes) * 60_000
}

export interface BarStore {
	load(): Promise<Bar[]>
	append(bar: Bar): Promise<void>
}
export interface ShadowWriter {
	/** Keys of records already written for a day (restart-safe dedupe). */
	existingKeys(day: string): Set<string>
	append(day: string, record: object): void
}

export interface ShadowTradeRecord {
	type: 'trade'
	key: string
	variant: string
	side: 'LONG' | 'SHORT'
	sessionDate: string
	entryTime: string
	entryPrice: number
	exitTime: string
	exitPrice: number
	stop: number
	risk: number
	points: number
	r: number
	exitReason: string
	skipsSoFar: { positionOpen: number; stopOver80: number }
	data_quality: string[]
}

const iso = (ms: number) => new Date(ms).toISOString()

export class NiftyEmaShadow {
	private readonly p: StudyParams
	private readonly variants: VariantSpec[]
	private history: Bar[] = [] // closed candles BEFORE today's session (from the store)
	private today: Bar[] = [] // closed candles of the current session
	private day = ''
	private cur: Bar | null = null
	private curPartial = false // first candle after boot started before the detector saw a tick
	private sawFirstTick = false
	private incomplete = 0 // partial or gap candles today
	private emitted = new Set<string>()
	private summaryDone = new Set<string>()

	constructor(
		cfg: EmaStudyConfig,
		private readonly store: BarStore,
		private readonly writer: ShadowWriter,
		private readonly log: Pick<Console, 'log' | 'warn' | 'error'> = console,
	) {
		this.p = studyParams(cfg)
		this.variants = studyVariants(cfg)
	}

	/** Load stored candles. Today's earlier candles (mid-session restart) become `today`. */
	async init(nowMs: number): Promise<void> {
		let bars: Bar[] = []
		try {
			bars = await this.store.load()
		} catch (err) {
			this.log.error('[EmaShadow] ❌ Could not load stored candles — starting cold:', (err as Error).message)
		}
		const seen = new Set<number>()
		bars = bars.filter((b) => !seen.has(b.t) && !!seen.add(b.t)).sort((a, b) => a.t - b.t)
		this.day = new Date(nowMs + IST_MS).toISOString().slice(0, 10)
		const isToday = (b: Bar) => new Date(b.t + IST_MS).toISOString().slice(0, 10) === this.day
		this.history = bars.filter((b) => !isToday(b))
		this.today = bars.filter(isToday)
		this.emitted = this.writer.existingKeys(this.day)
		this.log.log(
			`[EmaShadow] 🧪 ACTIVE — shadow only (no alerts, no filter, no paper trades) · ${this.variants.map((v) => v.id).join(', ')} · history ${this.history.length} candles${this.history.length < WARMUP_FULL_BARS ? ` (< ${WARMUP_FULL_BARS}: rows flagged warmup_partial)` : ''} · today ${this.today.length}`,
		)
	}

	/** Synchronous per-tick update; work happens only when a candle closes. */
	onTick(price: number, ts: number): void {
		if (!(price > 0)) return
		// Session ticks only: the study's candles run 09:15–15:30 IST.
		const ist = ts + IST_MS
		const minOfDay = Math.floor((ist % DAY_MS) / 60_000)
		if (minOfDay < SESSION_OPEN_MIN || minOfDay >= SESSION_CLOSE_MIN) return
		const start = bucketStart(ts, this.p.barMinutes)
		if (!this.sawFirstTick) {
			this.sawFirstTick = true
			this.curPartial = ts - start > PARTIAL_TOLERANCE_MS // boot after this candle began: it misses its start
		}
		if (this.cur && start === this.cur.t) {
			this.cur.h = Math.max(this.cur.h, price)
			this.cur.l = Math.min(this.cur.l, price)
			this.cur.c = price
			return
		}
		if (this.cur && start < this.cur.t) return // out-of-order tick: ignore
		if (this.cur) this.closeCandle(this.cur, start)
		this.cur = { t: start, o: price, h: price, l: price, c: price }
	}

	private closeCandle(bar: Bar, nextStart: number): void {
		const day = new Date(bar.t + IST_MS).toISOString().slice(0, 10)
		if (day !== this.day) {
			// new session: yesterday's candles join history
			this.history = [...this.history, ...this.today].slice(-MAX_STORED_BARS)
			this.today = []
			this.day = day
			this.incomplete = 0
			this.emitted = this.writer.existingKeys(day)
		}
		const last = this.today.at(-1)
		if (last && bar.t - last.t > this.p.barMinutes * 60_000) this.incomplete++ // a 5-min bucket with no tick
		const sessionOpenMs = bar.t - ((bar.t + IST_MS) % DAY_MS) + SESSION_OPEN_MIN * 60_000
		if (!last && bar.t !== sessionOpenMs) this.incomplete++ // the session's first candle is not the 09:15 one
		if (this.curPartial) this.incomplete++
		this.curPartial = false
		this.today.push(bar)
		this.store.append(bar).catch((err) => this.log.error('[EmaShadow] ❌ Could not store candle:', (err as Error).message))
		try {
			this.evaluate()
		} catch (err) {
			this.log.error('[EmaShadow] ❌ Evaluation error (shadow only, engine unaffected):', err)
		}
		void nextStart
	}

	/** Run every variant over history + today; write trades whose exit is final, and the 15:15 summary. */
	evaluate(): void {
		const bars = toSessionBars([...this.history, ...this.today], this.p.barMinutes)
		const lastIdx = bars.length - 1
		const flags = [
			...(this.history.length < WARMUP_FULL_BARS ? ['warmup_partial'] : []),
			...(this.incomplete > 0 ? ['bars_incomplete'] : []),
		]
		const summary: Record<string, unknown> = { type: 'summary', key: `summary:${this.day}`, sessionDate: this.day, candles: this.today.length, incompleteCandles: this.incomplete, data_quality: flags, variants: {} as Record<string, unknown> }
		for (const v of this.variants) {
			const res = runVariant(bars, v, this.p)
			const todaysSignals = res.signalLog.filter((s) => s.sessionDate === this.day)
			const skips = { positionOpen: todaysSignals.filter((s) => s.outcome === 'SKIP_OPEN').length, stopOver80: todaysSignals.filter((s) => s.outcome === 'SKIP_WIDE').length }
			const final = res.trades.filter((t) => t.sessionDate === this.day && t.reason !== 'SESSION_END_GAP' && t.exitIdx <= lastIdx)
			for (const t of final) {
				const key = `${v.id}:${t.entryTs}`
				if (this.emitted.has(key)) continue
				this.emitted.add(key)
				const rec: ShadowTradeRecord = {
					type: 'trade', key, variant: v.label, side: t.side, sessionDate: t.sessionDate,
					entryTime: iso(t.entryTs), entryPrice: t.entry, exitTime: iso(t.exitTs), exitPrice: t.exit,
					stop: t.stop, risk: t.risk, points: t.pts, r: t.r, exitReason: t.reason, skipsSoFar: skips, data_quality: flags,
				}
				this.writer.append(this.day, rec)
			}
			const all = res.trades.filter((t) => t.sessionDate === this.day && t.reason !== 'SESSION_END_GAP')
			;(summary.variants as Record<string, unknown>)[v.id] = {
				signals: todaysSignals.length, trades: all.length, open: res.trades.filter((t) => t.sessionDate === this.day && t.reason === 'SESSION_END_GAP').length,
				sumR: Number(all.reduce((a, t) => a + t.r, 0).toFixed(3)), points: Number(all.reduce((a, t) => a + t.pts, 0).toFixed(2)), skips,
			}
		}
		const lastBar = bars[lastIdx]
		if (lastBar && lastBar.closeMin >= this.p.forcedExitCloseMinute && !this.summaryDone.has(this.day) && !this.emitted.has(`summary:${this.day}`)) {
			this.summaryDone.add(this.day)
			this.emitted.add(`summary:${this.day}`)
			this.writer.append(this.day, summary)
			const v = summary.variants as Record<string, { trades: number; sumR: number; skips: { positionOpen: number; stopOver80: number } }>
			this.log.log(
				`[EmaShadow] 📊 ${this.day} · ${this.today.length} candles${this.incomplete ? ` (${this.incomplete} incomplete)` : ''} · ` +
					Object.entries(v).map(([id, s]) => `${id}: ${s.trades} trades, ΣR ${s.sumR}, skips open ${s.skips.positionOpen} / >80 ${s.skips.stopOver80}`).join(' · ') +
					(flags.length ? ` · ${flags.join(',')}` : ''),
			)
		}
	}
}

// ── I/O implementations ─────────────────────────────────────────────────────

/** Minimal slice of node-redis v5 the store needs. */
export interface RedisListLike {
	lRange(key: string, start: number, stop: number): Promise<string[]>
	rPush(key: string, value: string): Promise<number>
	lTrim(key: string, start: number, stop: number): Promise<unknown>
}

export const redisBarStore = (r: RedisListLike, key = EMA_SHADOW_BARS_KEY): BarStore => ({
	load: async () => (await r.lRange(key, 0, -1)).map((s) => JSON.parse(s) as Bar),
	append: async (bar) => {
		await r.rPush(key, JSON.stringify({ t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c }))
		await r.lTrim(key, -MAX_STORED_BARS, -1)
	},
})

/** One JSONL file per IST day. Appends are asynchronous (never block the tick handler). */
export const jsonlWriter = (dir: string, log: Pick<Console, 'error'> = console): ShadowWriter => ({
	existingKeys: (day) => {
		const keys = new Set<string>()
		try {
			for (const line of fs.readFileSync(path.join(dir, `${day}.jsonl`), 'utf8').split('\n'))
				if (line.trim()) keys.add((JSON.parse(line) as { key: string }).key)
		} catch {
			// no file yet
		}
		return keys
	},
	append: (day, record) => {
		fs.promises
			.mkdir(dir, { recursive: true })
			.then(() => fs.promises.appendFile(path.join(dir, `${day}.jsonl`), JSON.stringify(record) + '\n'))
			.catch((err) => log.error('[EmaShadow] ❌ Could not write JSONL:', (err as Error).message))
	},
})

export const emaShadowEnabled = (raw: string | undefined): boolean => raw !== 'false'

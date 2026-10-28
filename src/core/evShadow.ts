// ============================================================
// src/core/evShadow.ts — "what would an EV-rejected fire have done?" (observation only)
//
// When the EV hard gate rejects a fire, nothing is alerted and no paper trade is recorded. This
// module records a SIMULATED outcome for it, under the paper-trade rules:
//   - levels: core/tradeLevels.ts, the same function the paper trade uses;
//   - exits: the same order as positionTracker.processTick (15:15 TIME for INTRADAY, then stop,
//     then target, on the tick price);
//   - R: the same formula.
// It writes ONLY to its own table, ev_shadow_outcomes (migration 0007). It never touches
// paper_trades, trades:open, trades:history, pnl:daily, the alert path or any stat, so alerts,
// positions and stats are identical with it on or off (tests/evShadow.test.ts).
//
// Off by default: EV_SHADOW_ENABLED=true turns it on. It is bounded: EV_SHADOW_DAILY_CAP new rows
// a day, EV_SHADOW_MAX_OPEN open at once, and one open per symbol + detector + side. Every
// failure is swallowed (recording fails open, and this is not even a recording of a real trade).
//
// Nifty option fires carry index-level SL/T1 (parsed from the trigger), and no option ticks are
// subscribed. Their shadow is evaluated on NSE:NIFTY50-INDEX ticks and flagged 'index_proxy'. Paper
// trades for options can't close at all; that is the one place this differs from paper.
// ============================================================

import type { AlertPayload } from '../workers/telegramWorker.js'
import type { FilterDecision } from '../detectors/janeStreetFilter.js'
import { computeTradeLevels } from './tradeLevels.js'

export const NIFTY_INDEX = 'NSE:NIFTY50-INDEX'
export const EV_SHADOW_DAILY_CAP = 50
export const EV_SHADOW_MAX_OPEN = 20
export const EV_SHADOW_INIT_TIMEOUT_MS = 5000

export const evShadowEnabled = (): boolean => process.env.EV_SHADOW_ENABLED === 'true'

type Side = 'LONG' | 'SHORT'
export type ShadowExitReason = 'STOP_LOSS' | 'TARGET' | 'TIME'

export interface ShadowOpen {
	id: number
	key: string
	symbol: string
	trackedSymbol: string
	side: Side
	entry: number
	stop: number
	target: number
	durationClass: 'INTRADAY' | 'SWING'
}

export interface ShadowInsert {
	signalId: string | null
	tradeDate: string
	symbol: string
	trackedSymbol: string
	detector: string | null
	side: Side
	score: number
	ev: number
	entry: number
	stop: number
	target: number
	entryTs: number
	durationClass: 'INTRADAY' | 'SWING'
	dataQuality: string[]
}

export interface EvShadowStore {
	insert(row: ShadowInsert): Promise<number | null>
	close(id: number, exit: { price: number; ts: number; reason: ShadowExitReason; r: number | null }): Promise<void>
	/** Today's rows still OPEN (a same-day restart keeps tracking them). */
	loadOpen(tradeDate: string): Promise<(ShadowOpen & { detector: string | null })[]>
	/** Rows of earlier days still OPEN can never be closed: mark them UNRESOLVED. Returns the count. */
	markUnresolved(beforeDate: string): Promise<number>
	/** Rows already recorded today, any status: the daily cap counts these after a same-day restart. */
	countToday(tradeDate: string): Promise<number>
}

const IST_MS = 5.5 * 3600 * 1000
const istDate = (ms: number) => new Date(ms + IST_MS).toISOString().slice(0, 10)
const istMinutes = (ms: number) => {
	const d = new Date(ms + IST_MS)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** positionTracker.processTick's exit rule, in its order. */
export const shadowExit = (
	p: Pick<ShadowOpen, 'side' | 'stop' | 'target' | 'durationClass'>,
	ltp: number,
	minutesIst: number,
): ShadowExitReason | null => {
	if (minutesIst >= 15 * 60 + 15 && (!p.durationClass || p.durationClass === 'INTRADAY')) return 'TIME'
	if (p.side === 'LONG') {
		if (ltp <= p.stop) return 'STOP_LOSS'
		if (ltp >= p.target) return 'TARGET'
	} else {
		if (ltp >= p.stop) return 'STOP_LOSS'
		if (ltp <= p.target) return 'TARGET'
	}
	return null
}

/** positionTracker's R: (exit - entry) / (entry - stop), sign by side; null on a zero denominator or non-finite R. */
export const shadowR = (side: Side, entry: number, stop: number, exit: number): number | null => {
	const den = side === 'LONG' ? entry - stop : stop - entry
	if (den === 0) return null
	const r = side === 'LONG' ? (exit - entry) / den : (entry - exit) / den
	return isFinite(r) ? Number(r.toFixed(4)) : null
}

export class EvShadowTracker {
	private open = new Map<string, ShadowOpen[]>() // trackedSymbol → open shadows
	private keys = new Set<string>() // symbol|detector|side of every open or in-flight shadow
	private day = ''
	private disabled = false
	private today = 0
	readonly counts = { recorded: 0, closed: 0, skippedCap: 0, skippedOpenLimit: 0, skippedDuplicate: 0, skippedGeometry: 0, errors: 0 }

	constructor(
		private store: EvShadowStore,
		private now: () => number = () => Date.now(),
		private log: Pick<Console, 'log' | 'warn'> = console,
	) {}

	/** Open shadows plus inserts still in flight: `keys` holds both, so a burst can't overshoot the limit. */
	private openCount(): number {
		return this.keys.size
	}

	private add(p: ShadowOpen): void {
		const l = this.open.get(p.trackedSymbol) ?? []
		l.push(p)
		this.open.set(p.trackedSymbol, l)
		this.keys.add(p.key)
	}

	/**
	 * Boot: mark earlier days' OPEN rows UNRESOLVED; reload today's OPEN rows; count today's rows for the
	 * daily cap. Never throws, and never holds up boot for longer than INIT_TIMEOUT_MS (a hung query
	 * leaves the tracker inactive for the day instead).
	 */
	async init(timeoutMs = EV_SHADOW_INIT_TIMEOUT_MS): Promise<void> {
		const today = istDate(this.now())
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			const work = (async () => {
				const n = await this.store.markUnresolved(today)
				const rows = await this.store.loadOpen(today)
				const recorded = await this.store.countToday(today)
				return { n, rows, recorded }
			})()
			const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`init timed out after ${timeoutMs} ms`)), timeoutMs) })
			const { n, rows, recorded } = await Promise.race([work, timeout])
			for (const r of rows) this.add(r)
			this.day = today
			this.today = recorded // every row recorded today counts toward the cap, not only the reloaded OPEN ones
			this.log.log(`[EvShadow] 🧪 ACTIVE — observation only · ${rows.length} open today reloaded · ${recorded} recorded today · ${n} earlier OPEN marked UNRESOLVED`)
		} catch (err) {
			this.counts.errors++
			this.disabled = true // no state loaded: stay inactive today rather than exceed the cap or reopen rows
			this.log.warn('[EvShadow] ⚠️ init failed — inactive today (alerts and paper unaffected):', (err as Error)?.message ?? err)
		} finally {
			clearTimeout(timer)
		}
	}

	/** Called from the alert pipeline on an EV rejection. Synchronous; the write runs in the background. */
	record(data: AlertPayload, decision: FilterDecision, signalId: string | null): void {
		if (this.disabled) return
		try {
			const now = this.now()
			const today = istDate(now)
			if (today !== this.day) {
				this.day = today
				this.today = 0
			}
			if (this.today >= EV_SHADOW_DAILY_CAP) {
				this.counts.skippedCap++
				return
			}
			if (this.openCount() >= EV_SHADOW_MAX_OPEN) {
				this.counts.skippedOpenLimit++
				return
			}
			const key = `${data.symbol}|${data.detectorName ?? ''}|${data.side}`
			if (this.keys.has(key)) {
				this.counts.skippedDuplicate++
				return
			}
			const lv = computeTradeLevels(data)
			const long = data.side === 'LONG'
			const valid = long ? lv.stopLoss < lv.entry && lv.target1 > lv.entry : lv.stopLoss > lv.entry && lv.target1 < lv.entry
			if (!valid) {
				this.counts.skippedGeometry++
				return
			}
			const trackedSymbol = lv.isOptions ? NIFTY_INDEX : data.symbol
			const durationClass = data.durationClass || 'INTRADAY'
			this.today++
			this.keys.add(key) // reserved now, so a second fire before the insert resolves is a duplicate
			const row: ShadowInsert = {
				signalId,
				tradeDate: today,
				symbol: data.symbol,
				trackedSymbol,
				detector: data.detectorName ?? null,
				side: data.side,
				score: decision.score,
				ev: decision.ev,
				entry: lv.entry,
				stop: lv.stopLoss,
				target: lv.target1,
				entryTs: now,
				durationClass,
				dataQuality: lv.isOptions ? ['index_proxy'] : [],
			}
			this.store
				.insert(row)
				.then((id) => {
					if (id === null) {
						this.keys.delete(key)
						return
					}
					this.counts.recorded++
					const l = this.open.get(trackedSymbol) ?? []
					l.push({ id, key, symbol: data.symbol, trackedSymbol, side: data.side, entry: lv.entry, stop: lv.stopLoss, target: lv.target1, durationClass })
					this.open.set(trackedSymbol, l)
				})
				.catch((err) => {
					this.keys.delete(key)
					this.counts.errors++
					this.log.warn('[EvShadow] ⚠️ insert failed (alerts and paper unaffected):', (err as Error)?.message ?? err)
				})
		} catch {
			this.counts.errors++
		}
	}

	/** One tick. Closes every open shadow on this symbol that the paper rules would close. Never throws. */
	async onTick(symbol: string, ltp: number, ts: number): Promise<void> {
		const list = this.open.get(symbol)
		if (!list || list.length === 0) return
		const m = istMinutes(ts)
		const closing: { p: ShadowOpen; reason: ShadowExitReason }[] = []
		const keep: ShadowOpen[] = []
		for (const p of list) {
			const reason = shadowExit(p, ltp, m)
			if (reason) closing.push({ p, reason })
			else keep.push(p)
		}
		if (closing.length === 0) return
		// Leave the open set BEFORE any await, so an overlapping tick can't close the same row twice.
		if (keep.length) this.open.set(symbol, keep)
		else this.open.delete(symbol)
		for (const { p, reason } of closing) {
			this.keys.delete(p.key)
			try {
				await this.store.close(p.id, { price: ltp, ts, reason, r: shadowR(p.side, p.entry, p.stop, ltp) })
				this.counts.closed++
			} catch (err) {
				this.counts.errors++
				this.log.warn('[EvShadow] ⚠️ close failed (row stays OPEN, then UNRESOLVED next day):', (err as Error)?.message ?? err)
			}
		}
	}

	openShadows(): ShadowOpen[] {
		return [...this.open.values()].flat()
	}
}

/** The Postgres store. The engine constructs it only when EV_SHADOW_ENABLED=true (the import itself is static). */
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- pg rows are untyped
export const pgEvShadowStore = (pool: { query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> }): EvShadowStore => ({
	async insert(r) {
		const res = await pool.query(
			`INSERT INTO ev_shadow_outcomes
			   (signal_id, trade_date, symbol, tracked_symbol, detector, direction, score, ev, entry_price, stop_price, target_price, entry_time, duration_class, data_quality)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12 / 1000.0), $13, $14)
			 RETURNING id`,
			[r.signalId, r.tradeDate, r.symbol, r.trackedSymbol, r.detector, r.side, r.score, r.ev, r.entry, r.stop, r.target, r.entryTs, r.durationClass, r.dataQuality],
		)
		return res.rows[0]?.id ?? null
	},
	async close(id, e) {
		await pool.query(
			`UPDATE ev_shadow_outcomes
			 SET status = 'CLOSED', exit_price = $1, exit_time = to_timestamp($2 / 1000.0), exit_reason = $3, r_multiple = $4
			 WHERE id = $5 AND status = 'OPEN'`,
			[e.price, e.ts, e.reason, e.r, id],
		)
	},
	async loadOpen(tradeDate) {
		const res = await pool.query(
			`SELECT id, symbol, tracked_symbol, detector, direction, entry_price, stop_price, target_price, duration_class
			 FROM ev_shadow_outcomes WHERE status = 'OPEN' AND trade_date = $1`,
			[tradeDate],
		)
		return res.rows.map((x) => ({
			id: x.id,
			key: `${x.symbol}|${x.detector ?? ''}|${x.direction}`,
			symbol: x.symbol,
			trackedSymbol: x.tracked_symbol,
			detector: x.detector,
			side: x.direction,
			entry: Number(x.entry_price),
			stop: Number(x.stop_price),
			target: Number(x.target_price),
			durationClass: x.duration_class,
		}))
	},
	async markUnresolved(beforeDate) {
		const res = await pool.query(`UPDATE ev_shadow_outcomes SET status = 'UNRESOLVED' WHERE status = 'OPEN' AND trade_date < $1`, [beforeDate])
		return res.rowCount ?? 0
	},
	async countToday(tradeDate) {
		const res = await pool.query(`SELECT count(*)::int AS n FROM ev_shadow_outcomes WHERE trade_date = $1`, [tradeDate])
		return Number(res.rows[0]?.n ?? 0)
	},
})

// The engine's instance: created at boot only when EV_SHADOW_ENABLED=true (ingestion/websocket.ts).
// Unset, every hook below is a no-op, which is what "off" means.
let instance: EvShadowTracker | null = null
export const getEvShadow = (): EvShadowTracker | null => instance
export const setEvShadow = (t: EvShadowTracker | null): void => {
	instance = t
}

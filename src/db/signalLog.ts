// ============================================================
// src/db/signalLog.ts — non-blocking, fail-safe writer for the `signals` table
//
//   enqueue()  push to an in-memory queue and return. Never awaits I/O, never throws.
//   flush      every FLUSH_MS, or as soon as BATCH_SIZE rows wait: one multi-row
//              INSERT … ON CONFLICT DO NOTHING.
//   failure    the batch is retried once, row by row, so one bad row can't sink
//              the other 99. A row that still fails is logged as
//              "[SignalLog] DROPPED {json}" (recoverable from docker logs).
//   cap        at MAX_QUEUE waiting rows the oldest is dropped and counted.
//   shutdown   flush() is awaited from websocket.ts's SIGTERM handler.
//
// Counters (visible in logs): rows skipped by the UNIQUE constraint, rows
// dropped by the queue cap, rows dropped after the retry. Each event logs a
// warning; shutdown() logs the session totals.
// ============================================================

import { SIGNAL_COLUMNS, type SignalRow } from './signalRecord.js'

export type QueryFn = (text: string, values: unknown[]) => Promise<{ rowCount: number | null }>

export interface SignalLogStats {
	enqueued: number
	inserted: number
	conflictSkipped: number // ON CONFLICT DO NOTHING — UNIQUE(detector, symbol, direction, fired_at) or PK
	queueCapDropped: number
	failedDropped: number
	batchRetries: number
}

export interface SignalLogOptions {
	query?: QueryFn
	flushMs?: number
	batchSize?: number
	maxQueue?: number
	log?: Pick<Console, 'warn' | 'error' | 'log'>
}

export const buildInsertSql = (rows: SignalRow[]): { text: string; values: unknown[] } => {
	const values: unknown[] = []
	const tuples = rows.map((row) => {
		const ph = SIGNAL_COLUMNS.map((c) => {
			values.push(row[c])
			return `$${values.length}`
		})
		return `(${ph.join(', ')})`
	})
	return {
		text: `INSERT INTO signals (${SIGNAL_COLUMNS.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
		values,
	}
}

const defaultQuery: QueryFn = async (text, values) => {
	const { pool } = await import('../config/db.js')
	return pool.query(text, values)
}

export class SignalLog {
	private queue: SignalRow[] = []
	private timer: ReturnType<typeof setInterval> | null = null
	private flushing: Promise<void> | null = null
	private readonly query: QueryFn
	private readonly flushMs: number
	private readonly batchSize: number
	private readonly maxQueue: number
	private readonly log: Pick<Console, 'warn' | 'error' | 'log'>

	readonly stats: SignalLogStats = {
		enqueued: 0,
		inserted: 0,
		conflictSkipped: 0,
		queueCapDropped: 0,
		failedDropped: 0,
		batchRetries: 0,
	}

	constructor(opts: SignalLogOptions = {}) {
		this.query = opts.query ?? defaultQuery
		this.flushMs = opts.flushMs ?? 1000
		this.batchSize = opts.batchSize ?? 100
		this.maxQueue = opts.maxQueue ?? 5000
		this.log = opts.log ?? console
	}

	get pending(): number {
		return this.queue.length
	}

	/** Never throws, never blocks. */
	enqueue(row: SignalRow): void {
		try {
			if (this.queue.length >= this.maxQueue) {
				this.queue.shift()
				this.stats.queueCapDropped++
				const n = this.stats.queueCapDropped
				if (n === 1 || n % 500 === 0) {
					this.log.warn(
						`[SignalLog] ⚠️ Queue full (${this.maxQueue}) — dropped oldest row (session total ${n})`,
					)
				}
			}
			this.queue.push(row)
			this.stats.enqueued++
			if (!this.timer) {
				this.timer = setInterval(() => void this.flush(), this.flushMs)
				this.timer.unref?.()
			}
			if (this.queue.length >= this.batchSize) void this.flush()
		} catch {
			// observation must never affect the caller
		}
	}

	/** Drain the queue. Concurrent calls share one drain. Never throws. */
	flush(): Promise<void> {
		if (this.flushing) return this.flushing
		// The guard is released in .finally(), which always runs asynchronously —
		// after this assignment. Clearing it inside the async body (as before) ran
		// synchronously when the queue was empty, BEFORE the assignment, leaving a
		// resolved promise in `flushing` forever: every later flush returned early
		// and nothing more was written (Oct 21: 1 of 4 rows; tests/signalLog.test.ts STALL).
		this.flushing = this.drain().finally(() => {
			this.flushing = null
		})
		return this.flushing
	}

	private async drain(): Promise<void> {
		try {
			while (this.queue.length > 0) {
				const batch = this.queue.splice(0, this.batchSize)
				await this.writeBatch(batch)
			}
		} catch (err) {
			this.log.error('[SignalLog] ❌ Unexpected flush error:', err)
		}
	}

	private count(attempted: number, rowCount: number | null): void {
		const inserted = rowCount ?? 0
		this.stats.inserted += inserted
		const skipped = attempted - inserted
		if (skipped > 0) {
			this.stats.conflictSkipped += skipped
			this.log.warn(
				`[SignalLog] ⚠️ ${skipped} row(s) skipped by UNIQUE constraint (session total ${this.stats.conflictSkipped})`,
			)
		}
	}

	private async writeBatch(rows: SignalRow[]): Promise<void> {
		try {
			const { text, values } = buildInsertSql(rows)
			const res = await this.query(text, values)
			this.count(rows.length, res.rowCount)
			return
		} catch (err) {
			this.stats.batchRetries++
			this.log.warn(
				`[SignalLog] ⚠️ Batch of ${rows.length} failed (${(err as Error).message}) — retrying row by row`,
			)
		}
		for (const row of rows) {
			try {
				const { text, values } = buildInsertSql([row])
				const res = await this.query(text, values)
				this.count(1, res.rowCount)
			} catch (err) {
				this.stats.failedDropped++
				this.log.error(
					`[SignalLog] DROPPED (${(err as Error).message}; session total ${this.stats.failedDropped}) ${JSON.stringify(row)}`,
				)
			}
		}
	}

	summary(): string {
		const s = this.stats
		return `[SignalLog] session totals: enqueued=${s.enqueued} inserted=${s.inserted} unique_skipped=${s.conflictSkipped} queue_cap_dropped=${s.queueCapDropped} failed_dropped=${s.failedDropped} batch_retries=${s.batchRetries} pending=${this.queue.length}`
	}

	/** Final flush (bounded by timeoutMs), stop the timer, log totals. Never throws. */
	async shutdown(timeoutMs = 2000): Promise<void> {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		await Promise.race([this.flush(), new Promise((r) => setTimeout(r, timeoutMs).unref?.())])
		this.log.log(this.summary())
	}
}

/** The process-wide instance used by telegramWorker / websocket.ts. */
export const signalLog = new SignalLog()

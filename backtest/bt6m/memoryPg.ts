// ============================================================
// backtest/bt6m/memoryPg.ts — in-memory stand-in for the two paper_trades statements the live
// position tracker sends (src/core/positionTracker.ts), so the LIVE tracker can run unchanged.
//
// Injected like memoryRedis: `pool` is a const binding but a mutable object shared by every importer,
// so an own `query` property replaces the prototype method for everyone. No socket is ever opened.
// Supported, by statement shape (anything else is recorded in `unknown` and returns no rows, so a run
// can assert none occurred):
//   INSERT INTO paper_trades (...) VALUES (...) RETURNING id          → a row, id = 1, 2, …
//   UPDATE paper_trades SET exit_price = $1, … WHERE id = $6 AND status IN ('OPEN','SKIPPED')  → close
//   UPDATE paper_trades SET data_quality = array_remove(data_quality, $1) WHERE id = $2           → flag
// ============================================================

import { pool } from '../../src/config/db.js'

export interface PaperRow {
	id: number
	symbol: string
	detector: string
	direction: 'LONG' | 'SHORT'
	entry_price: number
	entry_time: number // epoch ms
	stop_price: number
	target_price: number
	status: string
	regime_class: string | null
	gated: boolean
	qty: number
	capital_gated: boolean
	actual_size: number
	duration_class: string
	data_quality: string[]
	exit_price: number | null
	exit_time: number | null
	realized_pnl: number | null
	r_multiple: number | null
	exit_reason: string | null
}

export class MemoryPaperTrades {
	rows: PaperRow[] = []
	unknown: string[] = []
	private nextId = 1

	async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
		const sql = text.replace(/\s+/g, ' ').trim()
		if (/^INSERT INTO paper_trades \(/.test(sql) && /RETURNING id$/.test(sql)) {
			// Parameter order of positionTracker.registerTrade's INSERT.
			const p = params
			const row: PaperRow = {
				id: this.nextId++,
				symbol: String(p[0]),
				detector: String(p[1]),
				direction: p[2] as 'LONG' | 'SHORT',
				entry_price: Number(p[3]),
				entry_time: Number(p[4]),
				stop_price: Number(p[5]),
				target_price: Number(p[6]),
				regime_class: (p[7] as string | null) ?? null,
				gated: Boolean(p[8]),
				qty: Number(p[9]),
				capital_gated: Boolean(p[10]),
				actual_size: Number(p[11]),
				duration_class: String(p[12]),
				status: String(p[13]),
				data_quality: [...((p[14] as string[]) ?? [])],
				exit_price: null,
				exit_time: null,
				realized_pnl: null,
				r_multiple: null,
				exit_reason: null,
			}
			this.rows.push(row)
			return { rows: [{ id: row.id }], rowCount: 1 }
		}
		if (/^UPDATE paper_trades SET exit_price = \$1,/.test(sql) && /WHERE id = \$6 AND status IN \('OPEN', 'SKIPPED'\)$/.test(sql)) {
			const row = this.rows.find((r) => r.id === Number(params[5]) && (r.status === 'OPEN' || r.status === 'SKIPPED'))
			if (!row) return { rows: [], rowCount: 0 }
			row.exit_price = Number(params[0])
			row.exit_time = Number(params[1])
			row.realized_pnl = Number(params[2])
			row.r_multiple = params[3] === null ? null : Number(params[3])
			row.exit_reason = String(params[4])
			if (row.status !== 'SKIPPED') row.status = 'CLOSED'
			return { rows: [], rowCount: 1 }
		}
		if (/^UPDATE paper_trades SET data_quality = array_remove\(data_quality, \$1\) WHERE id = \$2$/.test(sql)) {
			const row = this.rows.find((r) => r.id === Number(params[1]))
			if (!row) return { rows: [], rowCount: 0 }
			row.data_quality = row.data_quality.filter((f) => f !== params[0])
			return { rows: [], rowCount: 1 }
		}
		this.unknown.push(sql.slice(0, 200))
		return { rows: [], rowCount: 0 }
	}
}

let active: MemoryPaperTrades | null = null

export const installMemoryPg = (): { store: MemoryPaperTrades; uninstall: () => void } => {
	if (active) throw new Error('[memoryPg] already installed')
	const store = new MemoryPaperTrades()
	const client = pool as unknown as Record<string, unknown>
	const had = Object.prototype.hasOwnProperty.call(client, 'query')
	const saved = client.query
	client.query = store.query.bind(store)
	active = store
	return {
		store,
		uninstall: () => {
			if (had) client.query = saved
			else delete client.query
			active = null
		},
	}
}

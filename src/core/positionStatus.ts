// ============================================================
// src/core/positionStatus.ts — paper_trades status rules (pure)
//
// Kept free of Redis/Postgres imports so tests can exercise the exact rules
// positionTracker uses.
//
// Statuses:
//   OPEN      a real paper position (actual size > 0), tracked until exit
//   CLOSED    an OPEN position that hit SL / target / 3:15 time exit
//   SKIPPED   a capital-skipped signal (actual size 0). Still tracked so its
//             exit and R get recorded, but it is never a position and never
//             becomes CLOSED — PnL is ₹0 by construction.
//   ORPHANED  a position no process tracks any more (e.g. an INTRADAY row left
//             over from a prior session). No exit/PnL/R is recorded: its real
//             outcome is unknown and must not be invented.
// ============================================================

export type TradeStatus = 'OPEN' | 'CLOSED' | 'SKIPPED' | 'ORPHANED'

/** IST calendar date (YYYY-MM-DD) of an epoch-ms timestamp. */
export const istDate = (epochMs: number): string =>
	new Date(epochMs + 5.5 * 3600 * 1000).toISOString().split('T')[0]!

/** Status and data_quality flags for a newly registered position. */
export const insertStatusFor = (pos: {
	size: number
	actualSize?: number
}): { status: TradeStatus; dataQuality: string[] } =>
	(pos.actualSize ?? pos.size) === 0
		? { status: 'SKIPPED', dataQuality: ['capital_skipped'] }
		: { status: 'OPEN', dataQuality: [] }

/**
 * A position reloaded from Redis at boot is orphaned when it is INTRADAY and
 * from a prior IST day: it should have been force-closed at 15:15 that day, and
 * closing it now would book the next session's price. SWING positions carry over.
 */
export const isOrphanedAtBoot = (
	pos: { timestamp: number; durationClass?: 'INTRADAY' | 'SWING' },
	nowMs: number,
): boolean =>
	(!pos.durationClass || pos.durationClass === 'INTRADAY') &&
	istDate(pos.timestamp) !== istDate(nowMs)

/**
 * The boot-time ORPHANED update for a prior-day leftover. Only a row that is still OPEN is a
 * real position no process tracks any more. A SKIPPED row (capital-skipped, size 0) was never a
 * position and keeps its status. Until 2026-10-26 this matched `status IN ('OPEN', 'SKIPPED')`
 * (bb7fb46) and relabelled capital-skipped Nifty options, which never close in-session, as
 * ORPHANED at the next boot (rows 1583, 1585, 1590, 1596, 1599, 1603).
 */
export const orphanUpdate = (match: { where: string; params: unknown[] }): { text: string; params: unknown[] } => ({
	text: `UPDATE paper_trades
	 SET status = 'ORPHANED',
	     data_quality = CASE WHEN 'orphaned' = ANY(data_quality) THEN data_quality ELSE array_append(data_quality, 'orphaned') END
	 WHERE ${match.where} AND status = 'OPEN'`,
	params: match.params,
})

// ── Position identity (2026-10-22) ──────────────────────────────────────────
// The id used to be `trade_<ms>_<symbol>`. On Oct 22 at 11:06 two detectors fired AEQUS LONG
// in the same millisecond: both positions got the same id, the second overwrote the first in
// the Redis hash `trades:open`, and after the 11:46 restart only one was reloaded (pnl:daily
// counted one close). Postgres rows were also closed by symbol + entry_time, which matches
// BOTH same-ms rows. Now: a unique id (detector slug + random suffix), and the Postgres row
// is addressed by its own primary key once known.

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '').slice(0, 24) || 'UNKNOWN'

/** `trade_<ms>_<symbol>_<detector>_<6 hex>` — unique even for same-ms fires on one symbol. */
export const newPositionId = (nowMs: number, symbol: string, detectorName: string, rand?: () => string): string =>
	`trade_${nowMs}_${symbol}_${slug(detectorName)}_${(rand ?? randomHex6)()}`

const randomHex6 = (): string => Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')

/**
 * Which paper_trades row(s) an UPDATE for this position targets: its own primary key when
 * known (`dbId`, set right after the INSERT and persisted in trades:open), else the legacy
 * symbol + entry_time match (positions registered before this change).
 */
export const rowMatch = (pos: { dbId?: number | null; symbol: string; timestamp: number }, firstParam: number): { where: string; params: unknown[] } =>
	pos.dbId != null
		? { where: `id = $${firstParam}`, params: [pos.dbId] }
		: { where: `symbol = $${firstParam} AND entry_time = to_timestamp($${firstParam + 1} / 1000.0)`, params: [pos.symbol, pos.timestamp] }

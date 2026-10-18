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

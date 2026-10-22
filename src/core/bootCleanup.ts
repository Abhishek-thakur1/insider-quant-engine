// ============================================================
// core/bootCleanup.ts — day-aware boot cleanup (owner, 2026-10-22)
//
// The boot cleanup used to delete session state on EVERY boot, so the 11:46 watchdog
// restart on Oct 22 wiped the regime returns, the Nifty bias, pnl:daily and every VCP
// history mid-session. Now it clears only PREVIOUS days' state:
//
//   - `engine:boot_day` holds the IST date of the last boot.
//   - NEW DAY (marker missing or older): delete the session keys below, including every
//     `v2:vcp_history:*` (also stale ones of symbols no longer on the watchlist), then
//     write today's marker.
//   - SAME-DAY RESTART (marker == today): keep them all. The caller re-loads the regime
//     returns into memory, because the regime engine computes from memory, not Redis.
//
// `jsfilter:stats` (the legacy un-dated hash) is removed on every boot, as before.
// Cooldowns, alert keys, trades:open, jsfilter:decisions, vwap:*, ema_shadow and the
// ledger were never cleared here and still aren't (see AGENTS.md §7).
// ============================================================

export const BOOT_DAY_KEY = 'engine:boot_day'

/** Session state that survives a same-day restart and is cleared on a new day. */
export const SESSION_KEYS = ['market:nifty:bias', 'regime:nifty:returns_1min', 'regime:nifty:current', 'pnl:daily'] as const
export const VCP_HISTORY_PATTERN = 'v2:vcp_history:*'
export const ALWAYS_CLEARED = ['jsfilter:stats'] as const
/** 7 days: a marker older than any plausible gap still reads as "not today". */
export const BOOT_DAY_TTL_SECS = 7 * 24 * 3600

export interface BootCleanupRedis {
	get(key: string): Promise<string | null>
	set(key: string, value: string, opts: { EX: number }): Promise<unknown>
	del(keys: string[]): Promise<number>
	/** Every key matching a glob (SCAN in production). */
	keys(pattern: string): Promise<string[]>
}

export interface BootCleanupResult {
	sameDay: boolean
	previousBootDay: string | null
	deleted: string[]
}

export const runBootCleanup = async (redis: BootCleanupRedis, todayIst: string): Promise<BootCleanupResult> => {
	const previousBootDay = await redis.get(BOOT_DAY_KEY)
	const sameDay = previousBootDay === todayIst
	const doomed: string[] = [...ALWAYS_CLEARED]
	if (!sameDay) doomed.push(...SESSION_KEYS, ...(await redis.keys(VCP_HISTORY_PATTERN)))
	if (doomed.length > 0) await redis.del(doomed)
	await redis.set(BOOT_DAY_KEY, todayIst, { EX: BOOT_DAY_TTL_SECS })
	return { sameDay, previousBootDay, deleted: doomed }
}

export const describeBootCleanup = (r: BootCleanupResult, todayIst: string, regimeReturnsRestored: number): string =>
	r.sameDay
		? `[Engine] 🧹 Boot cleanup: same-day restart (${todayIst}) — kept regime (${regimeReturnsRestored} returns restored), bias, pnl:daily, VCP histories`
		: `[Engine] 🧹 Boot cleanup: new day ${todayIst} (last boot ${r.previousBootDay ?? 'unknown'}) — cleared ${r.deleted.length} keys of previous sessions`

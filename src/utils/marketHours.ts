// IST calendar / session helpers. Pure — safe to import from tests without env.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

export const getISTDateString = (nowMs: number = Date.now()): string =>
	new Date(nowMs + IST_OFFSET_MS).toISOString().split('T')[0]!

export const getISTMinutes = (nowMs: number = Date.now()): number => {
	const d = new Date(nowMs + IST_OFFSET_MS)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

// NSE continuous session 09:15–15:30 IST. Outside it (pre-open lull, post-close)
// a silent socket is normal, not a zombie connection.
export const isMarketHours = (nowMs: number = Date.now()): boolean => {
	const m = getISTMinutes(nowMs)
	return m >= 9 * 60 + 15 && m < 15 * 60 + 30
}

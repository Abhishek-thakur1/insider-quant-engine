// ============================================================
// - Fyers Option Symbol Builder + Best Strike Selector
//
// Fyers symbol format for Nifty weekly options:
//   NSE:NIFTY{YY}{M}{DD}{STRIKE}{CE/PE}
//   where M = 1-9 for Jan-Sep, O=Oct, N=Nov, D=Dec
//   e.g. NSE:NIFTY2541722500CE = 17 Apr 2025, 22500 CE
//
// This module:
//   1. Builds the correct symbol string for any strike + expiry
//   2. Maintains a live tick store for subscribed option strikes
//   3. Picks the best strike when a signal fires based on:
//      - Highest OI (most liquid)
//      - Premium momentum (CE rising / PE falling)
//      - Not too deep OTM (ltp > 0 — has tradeable value)
// ============================================================

import type { fyersDataSocket } from 'fyers-api-v3'

const STRIKE_INTERVAL = 50
const STRIKES_EACH_SIDE = 7 // 7 CE + 7 PE = 14 strikes per side

// Month code map — Fyers uses single char for each month
const MONTH_CODE: Record<number, string> = {
	1: '1',
	2: '2',
	3: '3',
	4: '4',
	5: '5',
	6: '6',
	7: '7',
	8: '8',
	9: '9',
	10: 'O',
	11: 'N',
	12: 'D',
}

// ── Next weekly expiry (Thursday) ────────────────────────────────────────────
export const getNextThursday = (from: Date = new Date()): Date => {
	const ist = new Date(from.getTime() + 5.5 * 60 * 60 * 1000)
	const day = ist.getUTCDay() // 0=Sun, 4=Thu
	const daysUntilThursday = (4 - day + 7) % 7 || 7
	// If today IS Thursday and market is open, use today
	const isToday = day === 4
	const istMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes()
	const marketClosed = istMinutes >= 15 * 60 + 30

	if (isToday && !marketClosed) {
		return ist // today's expiry
	}
	const result = new Date(ist)
	result.setUTCDate(ist.getUTCDate() + (isToday ? 7 : daysUntilThursday))
	return result
}

// ── Build Fyers symbol string ─────────────────────────────────────────────────
export const buildOptionSymbol = (
	strike: number,
	optionType: 'CE' | 'PE',
	expiry?: Date,
): string => {
	const exp = expiry ?? getNextThursday()
	const yy = String(exp.getUTCFullYear()).slice(-2)
	const mm = MONTH_CODE[exp.getUTCMonth() + 1]!
	const dd = String(exp.getUTCDate()).padStart(2, '0')
	return `NSE:NIFTY${yy}${mm}${dd}${strike}${optionType}`
}

// ── Generate all strike symbols around ATM ────────────────────────────────────
export const buildOptionUniverse = (spotPrice: number): string[] => {
	const atm = Math.round(spotPrice / STRIKE_INTERVAL) * STRIKE_INTERVAL
	const expiry = getNextThursday()
	const symbols: string[] = []

	for (let i = -STRIKES_EACH_SIDE; i <= STRIKES_EACH_SIDE; i++) {
		if (i === 0) continue // skip ATM itself — included via i=0 below
		const strike = atm + i * STRIKE_INTERVAL
		symbols.push(buildOptionSymbol(strike, 'CE', expiry))
		symbols.push(buildOptionSymbol(strike, 'PE', expiry))
	}
	// Include ATM
	symbols.push(buildOptionSymbol(atm, 'CE', expiry))
	symbols.push(buildOptionSymbol(atm, 'PE', expiry))

	return symbols
}

// ── Live tick store for option strikes ───────────────────────────────────────
export interface OptionTick {
	symbol: string
	strike: number
	optionType: 'CE' | 'PE'
	ltp: number
	oi: number
	volume: number
	prevLtp: number // previous tick ltp — for momentum
	ltpHistory: number[] // last 5 ltp values — for trend
}

const optionTickStore = new Map<string, OptionTick>()

// Called from websocket.ts when a tick arrives for an option symbol
export const updateOptionTick = (
	symbol: string,
	tick: {
		ltp: number
		oi?: number
		volume?: number
	},
): void => {
	// Parse strike and type from symbol
	// NSE:NIFTY2541722500CE → strike=22500, type=CE
	const match = symbol.match(/NIFTY\d{4,6}(\d{4,6})(CE|PE)$/)
	if (!match) return

	const strike = parseInt(match[1]!)
	const optionType = match[2] as 'CE' | 'PE'

	const existing = optionTickStore.get(symbol)
	const prevLtp = existing?.ltp ?? tick.ltp
	const ltpHistory = existing?.ltpHistory ?? []

	ltpHistory.push(tick.ltp)
	if (ltpHistory.length > 5) ltpHistory.shift()

	optionTickStore.set(symbol, {
		symbol,
		strike,
		optionType,
		ltp: tick.ltp,
		oi: tick.oi ?? existing?.oi ?? 0,
		volume: tick.volume ?? existing?.volume ?? 0,
		prevLtp,
		ltpHistory,
	})
}

// ── Best strike selector ──────────────────────────────────────────────────────
// Called when signal fires. Scans all live ticks to find the optimal strike.
//
// Scoring per strike:
//   +3 pts — OI above median OI of all strikes of same type (liquid)
//   +3 pts — Premium momentum in signal direction (CE price rising / PE price rising for shorts)
//   +2 pts — LTP between ₹30–₹500 (not too cheap/expensive for scalping)
//   +1 pt  — Closest to ATM (lower risk, tighter spreads)
//
// Returns the highest scoring strike symbol, or falls back to ATM if no data yet.
export const getBestStrike = (
	direction: 'CE' | 'PE',
	spotPrice: number,
): { symbol: string; strike: number; ltp: number; reason: string } => {
	const atm = Math.round(spotPrice / STRIKE_INTERVAL) * STRIKE_INTERVAL
	const expiry = getNextThursday()

	// Filter to relevant option type with live data
	const candidates = Array.from(optionTickStore.values()).filter(
		(t) => t.optionType === direction && t.ltp > 0,
	)

	if (candidates.length === 0) {
		// No live data yet — fall back to ATM
		const fallbackSymbol = buildOptionSymbol(atm, direction, expiry)
		return {
			symbol: fallbackSymbol,
			strike: atm,
			ltp: 0,
			reason: 'fallback ATM — no live data yet',
		}
	}

	// Compute median OI
	const ois = candidates.map((c) => c.oi).sort((a, b) => a - b)
	const medianOI = ois[Math.floor(ois.length / 2)] ?? 0

	// Score each candidate
	const scored = candidates.map((c) => {
		let score = 0
		const reasons: string[] = []

		// OI liquidity
		if (c.oi >= medianOI && medianOI > 0) {
			score += 3
			reasons.push(`OI ${(c.oi / 1000).toFixed(0)}K ✅`)
		}

		// Premium momentum — is the premium moving in our favour?
		const trend =
			c.ltpHistory.length >= 3 ? c.ltpHistory[c.ltpHistory.length - 1]! - c.ltpHistory[0]! : 0
		if (trend > 0) {
			score += 3
			reasons.push(`premium +₹${trend.toFixed(1)} ✅`)
		}

		// Premium range ₹30–₹500 — tradeable zone
		if (c.ltp >= 30 && c.ltp <= 500) {
			score += 2
			reasons.push(`₹${c.ltp.toFixed(0)} in range ✅`)
		}

		// Proximity to ATM — closer = better
		const distanceStrikes = Math.abs(c.strike - atm) / STRIKE_INTERVAL
		if (distanceStrikes <= 2) {
			score += 1
			reasons.push(`${distanceStrikes} strikes from ATM ✅`)
		}

		return { ...c, score, reasons }
	})

	// Pick highest score
	scored.sort((a, b) => b.score - a.score)
	const best = scored[0]!

	return {
		symbol: best.symbol,
		strike: best.strike,
		ltp: best.ltp,
		reason: best.reasons.join(' | '),
	}
}

// ── Check if option symbols need resubscription (ATM shifted > 2 strikes) ────
// Call this periodically from websocket.ts when Nifty moves significantly
// export const hasATMShifted = (currentSpot: number, lastSubscribedSpot: number): boolean => {
//     const currentATM = Math.round(currentSpot / STRIKE_INTERVAL) * STRIKE_INTERVAL;
//     const lastATM = Math.round(lastSubscribedSpot / STRIKE_INTERVAL) * STRIKE_INTERVAL;
//     return Math.abs(currentATM - lastATM) >= 2 * STRIKE_INTERVAL; // shifted 2+ strikes
// };
export const hasATMShifted = (currentSpot: number, lastSubscribedSpot: number): boolean => {
	const currentATM = Math.round(currentSpot / STRIKE_INTERVAL) * STRIKE_INTERVAL
	const lastATM = Math.round(lastSubscribedSpot / STRIKE_INTERVAL) * STRIKE_INTERVAL

	// Require a definitive shift of strictly greater than 100 points (2 strikes)
	// This prevents flapping if spot is oscillating right on a boundary line.
	return Math.abs(currentATM - lastATM) > 2 * STRIKE_INTERVAL
}

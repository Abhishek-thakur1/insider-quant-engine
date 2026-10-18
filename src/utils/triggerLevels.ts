// ============================================================
// src/utils/triggerLevels.ts — SL / T1 parsed from a detector's trigger text
//
// Moved verbatim out of detectors/janeStreetFilter.ts (which re-exports it) so
// that modules without a Redis dependency — the signals log, tests — use the
// exact parser the EV gate uses rather than a divergent copy. The only change
// is additive: the raw matched `sl` / `t1` are returned as well (null when the
// text has no match). risk / reward / rr / parsed are computed exactly as before.
// ============================================================

export const DEFAULT_RR = 1.5 // Fallback R:R if trigger text is unparseable
export const DEFAULT_RISK_PCT = 0.003 // Fallback risk = 0.3% of price if no SL in trigger

export const parseRiskRewardFromTrigger = (
	trigger: string,
	price: number,
): {
	risk: number
	reward: number
	rr: number
	parsed: boolean
	sl: number | null
	t1: number | null
} => {
	const slMatch = trigger.match(/SL[:\s]*₹?([\d,]+(?:\.\d+)?)/i)
	const t1Match = trigger.match(/T1[:\s]*₹?([\d,]+(?:\.\d+)?)/i)
	const slRaw = slMatch ? parseFloat(slMatch[1]!.replace(/,/g, '')) : null
	const t1Raw = t1Match ? parseFloat(t1Match[1]!.replace(/,/g, '')) : null

	if (slMatch && t1Match) {
		const sl = slRaw!
		const t1 = t1Raw!

		if (sl > 0 && t1 > 0 && price > 0) {
			const risk = Math.abs(price - sl)
			const reward = Math.abs(price - t1)

			if (risk > 0 && reward > 0 && risk < price * 0.1 && reward < price * 0.2) {
				return { risk, reward, rr: reward / risk, parsed: true, sl: slRaw, t1: t1Raw }
			}
		}
	}

	const defaultRisk = price * DEFAULT_RISK_PCT
	const defaultReward = defaultRisk * DEFAULT_RR
	return {
		risk: defaultRisk,
		reward: defaultReward,
		rr: DEFAULT_RR,
		parsed: false,
		sl: slRaw,
		t1: t1Raw,
	}
}

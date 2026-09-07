const fs = require('fs');

let content = fs.readFileSync('src/utils/bayesianEngine.ts', 'utf8');

if (!content.includes('getClosedCandles')) {
    content = content.replace("import { getWallStrikes } from './optionUtils.js'", "import { getWallStrikes } from './optionUtils.js'\nimport { getClosedCandles } from './candleAggregator.js'");
}

const newZoneLogic = `	// ── EVIDENCE 4: VWAP Deviation Zone ──────────────────────────────────────
	// [FIX] Previously used flat % thresholds (0.1% to 0.5%) which punished volatile
	// assets by treating their normal moves as "overextended", and punished index/low-beta
	// by treating valid breakouts as "too small". Now scaled relative to 1-min ATR.
	const pct = Math.abs(payload.percentageChange)
	
	const candles = getClosedCandles(payload.symbol, 30)
	let typicalMovePct = 0.04 // Default fallback (roughly Nifty's 1-min ATR)
	if (candles.length >= 10) {
		let sumRange = 0
		for (const c of candles) sumRange += ((c.high - c.low) / c.close) * 100
		typicalMovePct = Math.max(0.01, sumRange / candles.length)
	}
	
	// Threshold multipliers calibrated against the old 0.04% baseline:
	// Momentum Sweet Spot: 2.5x to 12.5x ATR
	// Mean Reversion Target: > 10x ATR
	const extNeutral = typicalMovePct * 5.0
	const extStrong = typicalMovePct * 10.0
	const momEarly = typicalMovePct * 2.5
	const momLate = typicalMovePct * 12.5

	const isMeanReversion =
		payload.trigger.includes('OFE') ||
		payload.trigger.includes('Defense') ||
		payload.trigger.includes('Reversion') ||
		payload.trigger.includes('Exhaustion') ||
		payload.trigger.includes('Wyckoff') ||
		payload.trigger.includes('Trap') ||
		payload.regimeClass === 'REVERSION'

	if (isMeanReversion) {
		if (pct >= extStrong) {
			likelihoods.vwapZoneRatio = VOL_STRONG_LR
			reasons.push(\`✅ Reversion: \${pct.toFixed(2)}% VWAP dev (> \${extStrong.toFixed(2)}%) → strong setup (L=\${VOL_STRONG_LR})\`)
		} else if (pct >= extNeutral) {
			likelihoods.vwapZoneRatio = VWAP_NEUTRAL_LR
			reasons.push(\`○ Reversion: \${pct.toFixed(2)}% VWAP dev (moderate)\`)
		} else {
			likelihoods.vwapZoneRatio = VWAP_OVEREXTENDED_LR
			reasons.push(\`⚠️ Reversion: \${pct.toFixed(2)}% VWAP dev < \${extNeutral.toFixed(2)}% — too small (L=\${VWAP_OVEREXTENDED_LR})\`)
		}
	} else {
		if (pct >= momEarly && pct <= momLate) {
			likelihoods.vwapZoneRatio = VWAP_SWEET_SPOT_LR
			reasons.push(\`✅ Momentum: ±\${pct.toFixed(2)}% VWAP dev — sweet spot [\${momEarly.toFixed(2)}-\${momLate.toFixed(2)}%] (L=\${VWAP_SWEET_SPOT_LR})\`)
		} else if (pct > momLate) {
			likelihoods.vwapZoneRatio = VWAP_OVEREXTENDED_LR
			reasons.push(\`⚠️ Momentum: ±\${pct.toFixed(2)}% VWAP dev > \${momLate.toFixed(2)}% — overextended (L=\${VWAP_OVEREXTENDED_LR})\`)
		} else {
			likelihoods.vwapZoneRatio = VWAP_NEUTRAL_LR
			reasons.push(\`○ Momentum: ±\${pct.toFixed(2)}% VWAP dev < \${momEarly.toFixed(2)}% — early\`)
		}
	}`;

const startIndex = content.indexOf('	// ── EVIDENCE 4: VWAP Deviation Zone ──────────────────────────────────────');
const endIndex = content.indexOf('	// ── EVIDENCE 5: Time-of-Day Factor ───────────────────────────────────────');

if (startIndex > -1 && endIndex > -1) {
	const oldPart = content.substring(startIndex, endIndex);
	content = content.replace(oldPart, newZoneLogic + '\n\n');
	fs.writeFileSync('src/utils/bayesianEngine.ts', content);
	console.log('patched');
} else {
	console.log('not found');
}

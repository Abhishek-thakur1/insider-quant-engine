const fs = require('fs');
let content = fs.readFileSync('src/utils/bayesianEngine.ts', 'utf8');

const timeBlockStr = `	if (inPrimeWindow1 || inPrimeWindow2) {
		likelihoods.timeRatio = TIME_PRIME_LR
		reasons.push(\`✅ Prime liquidity window (L=\${TIME_PRIME_LR})\`)
	} else if (inDeadZone) {
		likelihoods.timeRatio = TIME_DEAD_LR
		reasons.push(\`⚠️ Lunch hour — low liquidity (L=\${TIME_DEAD_LR})\`)
	} else {
		likelihoods.timeRatio = TIME_NORMAL_LR
		reasons.push(\`○ Normal session time\`)
	}`;

const newTimeBlockStr = `	if (payload.durationClass === 'SWING') {
		likelihoods.timeRatio = 1.0
		reasons.push(\`○ Swing trade — time-of-day penalty bypassed (L=1.0)\`)
	} else if (inPrimeWindow1 || inPrimeWindow2) {
		likelihoods.timeRatio = TIME_PRIME_LR
		reasons.push(\`✅ Prime liquidity window (L=\${TIME_PRIME_LR})\`)
	} else if (inDeadZone) {
		likelihoods.timeRatio = TIME_DEAD_LR
		reasons.push(\`⚠️ Lunch hour — low liquidity (L=\${TIME_DEAD_LR})\`)
	} else {
		likelihoods.timeRatio = TIME_NORMAL_LR
		reasons.push(\`○ Normal session time\`)
	}`;
	
content = content.replace(timeBlockStr, newTimeBlockStr);

const biasBlockStr = `	if (biasAligned) {
		likelihoods.biasRatio = BIAS_ALIGNED_LR
		reasons.push(\`✅ Nifty \${marketBias} + signal aligned (L=\${BIAS_ALIGNED_LR})\`)
	} else if (biasOpposing) {
		likelihoods.biasRatio = BIAS_OPPOSING_LR
		reasons.push(\`🚨 Nifty \${marketBias} OPPOSES \${side} (L=\${BIAS_OPPOSING_LR}) — major red flag\`)
	} else {
		likelihoods.biasRatio = BIAS_NEUTRAL_LR
		reasons.push(\`○ Nifty neutral — no bias update\`)
	}`;
	
const newBiasBlockStr = `	if (payload.durationClass === 'SWING') {
		likelihoods.biasRatio = 1.0
		reasons.push(\`○ Swing trade — intraday Nifty VWAP bias bypassed (L=1.0)\`)
	} else if (biasAligned) {
		likelihoods.biasRatio = BIAS_ALIGNED_LR
		reasons.push(\`✅ Nifty \${marketBias} + signal aligned (L=\${BIAS_ALIGNED_LR})\`)
	} else if (biasOpposing) {
		likelihoods.biasRatio = BIAS_OPPOSING_LR
		reasons.push(\`🚨 Nifty \${marketBias} OPPOSES \${side} (L=\${BIAS_OPPOSING_LR}) — major red flag\`)
	} else {
		likelihoods.biasRatio = BIAS_NEUTRAL_LR
		reasons.push(\`○ Nifty neutral — no bias update\`)
	}`;
	
content = content.replace(biasBlockStr, newBiasBlockStr);

fs.writeFileSync('src/utils/bayesianEngine.ts', content);
console.log('patched swing bayes');

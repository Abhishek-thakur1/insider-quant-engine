// ============================================================
// tests/regimeGate.test.ts — the REGIME hard gate
//
// This covers `checkRegimeCompatibility`, the first of the two hard gates in
// janeStreetFilter. A rejection here drops the alert even in shadow mode, so
// misclassifying a detector silently changes which strategies can fire.
//
// Run: npm test
//
// NOTE ON IMPORTS: regimeDetector imports config/redis, which imports config/env,
// which calls process.exit(1) when credentials are absent. Dummy values are set
// before the dynamic import below. No Redis connection is opened — createClient
// is lazy and checkRegimeCompatibility is pure.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'

const { checkRegimeCompatibility } = await import('../src/utils/regimeDetector.js')

const H = 1.5 // entropy value; only used in the reason strings

// ── Precedence: explicit > detectorName > trigger text ──────────────────────

test('explicit regimeClass wins over a contradicting detector name', () => {
	const r = checkRegimeCompatibility('ranging', H, 'Nifty Trend Pulse', undefined, 'UNIVERSAL')
	assert.equal(r.detectorType, 'UNIVERSAL')
	assert.equal(r.classificationSource, 'explicit')
	assert.equal(r.allowed, true)
})

test('explicit regimeClass wins over contradicting trigger text', () => {
	const r = checkRegimeCompatibility('trending', H, undefined, '🪤 Bull Trap at 24500 OI Wall', 'UNIVERSAL')
	assert.equal(r.detectorType, 'UNIVERSAL')
	assert.equal(r.classificationSource, 'explicit')
	assert.equal(r.allowed, true)
})

test('detectorName is used when no explicit class is given', () => {
	const r = checkRegimeCompatibility('trending', H, 'Stock Momentum Breakout')
	assert.equal(r.detectorType, 'MOMENTUM')
	assert.equal(r.classificationSource, 'name')
})

test('trigger text is the last-resort fallback', () => {
	const r = checkRegimeCompatibility('ranging', H, undefined, '📦 Compression Breakout LONG')
	assert.equal(r.detectorType, 'MOMENTUM')
	assert.equal(r.classificationSource, 'trigger')
})

test('with nothing to classify on, defaults to UNIVERSAL and says so', () => {
	const r = checkRegimeCompatibility('ranging', H)
	assert.equal(r.detectorType, 'UNIVERSAL')
	assert.equal(r.classificationSource, 'default')
	assert.equal(r.allowed, true)
})

// ── Regression: the two misclassifications root cause #2 fixed ──────────────

test('REGRESSION: OI Liquidity Sweep is no longer classified REVERSION by its trigger', () => {
	// Its trigger contains the word "Trap", which classifyFromTrigger maps to
	// REVERSION — so in a trending regime this UNIVERSAL detector was suppressed.
	const viaTrigger = checkRegimeCompatibility(
		'trending',
		H,
		undefined,
		'🪤 Bear Trap at 24500 OI Wall | Spot 24512',
	)
	assert.equal(viaTrigger.detectorType, 'REVERSION')
	assert.equal(viaTrigger.allowed, false, 'the old behaviour: suppressed while trending')

	// With the explicit tag the detector now declares itself.
	const tagged = checkRegimeCompatibility(
		'trending',
		H,
		'Institutional OI Liquidity Sweep',
		'🪤 Bear Trap at 24500 OI Wall | Spot 24512',
		'UNIVERSAL',
	)
	assert.equal(tagged.detectorType, 'UNIVERSAL')
	assert.equal(tagged.allowed, true)
	assert.equal(tagged.sizeMult, 1.0)
})

test('REGRESSION: live momentum detector names now resolve to MOMENTUM, not the UNIVERSAL default', () => {
	// Before the pattern-list fix, none of these matched any entry, so
	// classifyDetector fell through to its UNIVERSAL default and regime
	// suppression never applied to the entire live momentum stack.
	for (const name of [
		'Stock Momentum Breakout',
		'Nifty Opening Range Explosion',
		'Nifty Trend Pulse',
		'Gap_And_Go_V2',
		'Volatility_Contraction_V2',
	]) {
		const r = checkRegimeCompatibility('trending', H, name)
		assert.equal(r.detectorType, 'MOMENTUM', `${name} should classify as MOMENTUM`)
	}
})

// ── The suppression matrix ──────────────────────────────────────────────────

test('MOMENTUM is suppressed in a ranging regime', () => {
	const r = checkRegimeCompatibility('ranging', 2.2, undefined, undefined, 'MOMENTUM')
	assert.equal(r.allowed, false)
	assert.equal(r.sizeMult, 0.0)
})

test('MOMENTUM runs full size in a trending regime', () => {
	const r = checkRegimeCompatibility('trending', 1.2, undefined, undefined, 'MOMENTUM')
	assert.equal(r.allowed, true)
	assert.equal(r.sizeMult, 1.0)
})

test('REVERSION is suppressed in a trending regime', () => {
	const r = checkRegimeCompatibility('trending', 1.2, undefined, undefined, 'REVERSION')
	assert.equal(r.allowed, false)
	assert.equal(r.sizeMult, 0.0)
})

test('REVERSION runs full size in a ranging regime', () => {
	const r = checkRegimeCompatibility('ranging', 2.2, undefined, undefined, 'REVERSION')
	assert.equal(r.allowed, true)
	assert.equal(r.sizeMult, 1.0)
})

test('transition halves size for both directional classes', () => {
	for (const cls of ['MOMENTUM', 'REVERSION'] as const) {
		const r = checkRegimeCompatibility('transition', 1.8, undefined, undefined, cls)
		assert.equal(r.allowed, true)
		assert.equal(r.sizeMult, 0.5, `${cls} should be half size in transition`)
	}
})

test('UNIVERSAL is regime-agnostic across every regime', () => {
	for (const regime of ['trending', 'transition', 'ranging'] as const) {
		const r = checkRegimeCompatibility(regime, H, undefined, undefined, 'UNIVERSAL')
		assert.equal(r.allowed, true, `UNIVERSAL should pass in ${regime}`)
		assert.equal(r.sizeMult, 1.0, `UNIVERSAL should be full size in ${regime}`)
	}
})

// ── The gate feeds janeStreetFilter's REGIME points: 12 x sizeMult ──────────

test('sizeMult maps to the REGIME point budget the filter expects', () => {
	const WEIGHT_REGIME = 12 // janeStreetFilter.WEIGHT_REGIME
	const full = checkRegimeCompatibility('trending', H, undefined, undefined, 'MOMENTUM')
	const half = checkRegimeCompatibility('transition', H, undefined, undefined, 'MOMENTUM')
	assert.equal(WEIGHT_REGIME * full.sizeMult, 12)
	assert.equal(WEIGHT_REGIME * half.sizeMult, 6)
})

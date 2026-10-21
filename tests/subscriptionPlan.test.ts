// ============================================================
// tests/subscriptionPlan.test.ts — data-socket subscription plan + cap check
//
// Exercises the real src/core/subscriptionPlan.ts that websocket.ts calls at
// boot, before any Fyers request, and the option count it reserves.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import {
	DEFAULT_SUBSCRIPTION_CAP,
	describePlan,
	planSubscription,
	subscriptionCapFromEnv,
} from '../src/core/subscriptionPlan.js'
import { buildOptionUniverse, OPTION_STRIKE_COUNT } from '../src/utils/optionUtils.js'

const NIFTY = 'NSE:NIFTY50-INDEX'
const eq = (n: number, prefix = 'W') => Array.from({ length: n }, (_, i) => `NSE:${prefix}${i}-EQ`)

test('tonight’s test: 25-name watchlist, no bench, options off → 26 symbols', () => {
	const p = planSubscription({ watchlist: eq(25), bench: [], indexSymbol: NIFTY, optionStrikes: 0, cap: 100 })
	assert.equal(p.total, 26)
	assert.equal(p.symbols.length, 26)
	assert.equal(p.symbols.at(-1), NIFTY)
	assert.equal(p.overCap, false)
	assert.equal(describePlan(p), '26/100 symbols — watchlist 25 + bench 0 + index 1 + options 0')
})

test('target: watchlist 60 + bench 30 + Nifty + options 0 = 91 of 100', () => {
	const p = planSubscription({ watchlist: eq(60), bench: eq(30, 'B'), indexSymbol: NIFTY, optionStrikes: 0, cap: 100 })
	assert.equal(p.total, 91)
	assert.equal(p.overCap, false)
})

test('over the cap is refused: the old 2,158-name firehose, or options re-enabled on a full list', () => {
	assert.equal(planSubscription({ watchlist: eq(2158), bench: [], indexSymbol: NIFTY, optionStrikes: 0, cap: 100 }).overCap, true)
	const withOptions = planSubscription({ watchlist: eq(60), bench: eq(30, 'B'), indexSymbol: NIFTY, optionStrikes: OPTION_STRIKE_COUNT, cap: 100 })
	assert.equal(withOptions.total, 121)
	assert.equal(withOptions.overCap, true)
	assert.equal(planSubscription({ watchlist: eq(99), bench: [], indexSymbol: NIFTY, optionStrikes: 0, cap: 100 }).overCap, false, 'exactly at the cap is allowed')
})

test('duplicates count once: bench names already on the watchlist, Nifty listed twice', () => {
	const p = planSubscription({ watchlist: [...eq(3), NIFTY], bench: [...eq(2), 'NSE:X-EQ'], indexSymbol: NIFTY, optionStrikes: 0, cap: 100 })
	assert.deepEqual(p.symbols, [...eq(3), NIFTY, 'NSE:X-EQ'])
	assert.equal(p.watchlist, 4)
	assert.equal(p.bench, 1)
	assert.equal(p.index, 0)
	assert.equal(p.total, 5)
})

test('the reserved option count matches what buildOptionUniverse subscribes', () => {
	assert.equal(OPTION_STRIKE_COUNT, 30)
	assert.equal(buildOptionUniverse(22_950).length, OPTION_STRIKE_COUNT)
})

test('SUBSCRIPTION_CAP: positive integers only, otherwise the Standard limit', () => {
	assert.equal(DEFAULT_SUBSCRIPTION_CAP, 100)
	assert.equal(subscriptionCapFromEnv('91'), 91)
	for (const bad of [undefined, '', '0', '-5', '12.5', 'abc']) assert.equal(subscriptionCapFromEnv(bad), 100, String(bad))
})

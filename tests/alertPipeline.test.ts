// ============================================================
// tests/alertPipeline.test.ts — the signals hook is purely observational
//
// Runs the real src/workers/alertPipeline.ts (the body of sendTelegramAlert)
// against fake I/O for every outcome the worker can reach, three times each:
//   1. no observation draft          (behaviour without the hook)
//   2. a real draft                  (behaviour with the hook)
//   3. a draft that throws on every read and write
// and asserts the recorded side effects — filter calls, trades registered,
// Redis policy operations, Telegram sends, admin notices, console output —
// are identical across all three. Each scenario also pins the expected
// outcome (golden), taken from the pre-hook worker code, and checks the
// signals row the draft produces agrees with what actually happened.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSignalRow, newSignalDraft, type SignalDraft } from '../src/db/signalRecord.js'
import { NOW, equity, scenarios, runPipeline } from './helpers/workerScenarios.js'

const throwingDraft = (): SignalDraft =>
	new Proxy({} as SignalDraft, {
		get() {
			throw new Error('observer read')
		},
		set() {
			throw new Error('observer write')
		},
	})

for (const sc of scenarios) {
	test(`observational: ${sc.name}`, async () => {
		const payload = sc.payload ?? equity
		const without = await runPipeline(sc, null)
		const draft = newSignalDraft(payload, {
			signalId: '00000000-0000-4000-8000-000000000000',
			firedAt: NOW,
			shadowMode: !!sc.shadowMode,
		})
		const withHook = await runPipeline(sc, draft)
		const withBrokenHook = await runPipeline(sc, throwingDraft())

		// 1. Identical behaviour with and without the hook, even a broken one.
		assert.deepEqual(withHook, without, 'hook changed behaviour')
		assert.deepEqual(withBrokenHook, without, 'a throwing hook changed behaviour')

		// 2. Golden outcome (pre-hook worker semantics).
		const kinds = without.map((e) => e[0])
		assert.equal(
			kinds.includes('registerTrade'),
			sc.golden.registered || !!sc.registerThrows,
			'registered',
		)
		assert.equal(kinds.filter((k) => k === 'send').length, sc.golden.sends, 'send attempts')
		assert.equal(kinds.includes('delivered'), sc.golden.delivered, 'delivered')
		assert.equal(kinds.includes('admin'), sc.golden.admin, 'admin notice')

		// 3. The signals row agrees with what actually happened.
		const row = buildSignalRow(draft, {
			threshold: 78,
			promotionSource: /NIFTY/.test(payload.symbol) ? 'INDEX' : 'SCREENER',
		})
		for (const [k, v] of Object.entries(sc.row))
			assert.deepEqual(row[k as keyof typeof row], v, `row.${k}`)
		assert.equal(row.alert_sent, sc.golden.delivered)
	})
}

test('SEND_FAILED releases the reserved alert slot (unchanged behaviour)', async () => {
	const sc = scenarios.find((s) => s.sendFail === 'both')!
	const effects = await runPipeline(sc, null)
	assert.ok(effects.some((e) => e[0] === 'redis.del'))
	assert.ok(effects.some((e) => e[0] === 'redis.decr'))
})

// ── REAL-PATH direction tests (2026-10-21) ───────────────────────────────────
// tests/shortDirectionGeometry.test.ts re-implements formulas and imports no
// src/ code. These run the real runAlertPipeline with a passing decision and
// read the levels it REGISTERS and SENDS. For equities the pipeline ignores the
// trigger's SL/T1 and derives stop = VWAP × 0.998 (LONG) / × 1.002 (SHORT),
// target = entry ± 1.5 × |entry − stop|.

import { decision as passedDecision, type Scenario } from './helpers/workerScenarios.js'
import { levelGeometryProblem } from '../src/workers/alertPolicy.js'

type Pos = { side: string; entryPrice: number; stopLoss: number; target: number }

const realPath = async (side: 'LONG' | 'SHORT', price: number, vwap: number, symbol = 'NSE:TEST-EQ', trigger = 'x | SL ₹496 | T1 ₹506') => {
	const sc: Scenario = {
		name: `real-path ${side} ${price} vs VWAP ${vwap}`,
		payload: { ...equity, symbol, side, price, vwap, trigger },
		decision: passedDecision(),
		golden: { registered: true, sends: 1, delivered: true, admin: false },
		row: {},
	}
	const effects = await runPipeline(sc, null)
	const reg = effects.find((e) => e[0] === 'registerTrade')
	const sends = effects.filter((e) => e[0] === 'send').map((e) => String(e[2]))
	return { pos: reg ? (reg[1] as Pos) : null, sends }
}

const geometryOk = (p: Pos) => levelGeometryProblem({ side: p.side as 'LONG' | 'SHORT', entry: p.entryPrice, stop: p.stopLoss, target: p.target }) === null

for (const [side, price, vwap] of [
	['SHORT', 497, 499], // entry below VWAP — the detectors' intended SHORT case
	['SHORT', 499, 499], // entry at VWAP
	['LONG', 505, 499], // entry above VWAP — intended LONG case
	['LONG', 499, 499], // entry at VWAP
] as const) {
	test(`REAL-PATH ${side}: entry ${price} vs VWAP ${vwap} → correct side, registered and alerted`, async () => {
		const { pos, sends } = await realPath(side, price, vwap)
		assert.ok(pos, 'registered')
		assert.equal(pos.side, side)
		assert.equal(pos.entryPrice, price)
		const expStop = side === 'SHORT' ? Number((vwap * 1.002).toFixed(2)) : Number((vwap * 0.998).toFixed(2))
		assert.equal(pos.stopLoss, expStop)
		assert.ok(geometryOk(pos), `geometry ${JSON.stringify(pos)}`)
		if (side === 'SHORT') assert.ok(pos.target < price && price < pos.stopLoss)
		else assert.ok(pos.stopLoss < price && price < pos.target)
		assert.equal(sends.length, 1)
	})
}

// KNOWN DEFECT, pinned (not fixed): entry on the wrong side of VWAP puts the stop on the wrong side of entry,
// and the trade is still registered and alerted. The proposed levelGeometryProblem() flags it; nothing calls it yet.
for (const [side, price, vwap] of [
	['SHORT', 505, 499], // SHORT above VWAP: stop 499.998 is BELOW entry 505
	['LONG', 495, 499], // LONG below VWAP: stop 498.002 is ABOVE entry 495
] as const) {
	test(`REAL-PATH ${side} adversarial: entry ${price} vs VWAP ${vwap} → stop on the WRONG side, still alerted (known defect)`, async () => {
		const { pos, sends } = await realPath(side, price, vwap)
		assert.ok(pos)
		if (side === 'SHORT') assert.ok(pos.stopLoss < price, `stop ${pos.stopLoss} vs entry ${price}`)
		else assert.ok(pos.stopLoss > price, `stop ${pos.stopLoss} vs entry ${price}`)
		assert.equal(sends.length, 1, 'alerted today — the proposed guard would suppress this')
		assert.equal(levelGeometryProblem({ side, entry: pos.entryPrice, stop: pos.stopLoss, target: pos.target }), 'STOP_WRONG_SIDE')
	})
}

test('REAL-PATH option SHORT adversarial: trigger SL below entry is passed through unchecked (known defect)', async () => {
	// Option alerts take SL/T1 from the trigger text. A SHORT trigger with SL below entry is not caught.
	const { pos, sends } = await realPath('SHORT', 25000, 24990, 'NIFTY 25000 PE', 'bad | SL ₹24950 | T1 ₹24900')
	assert.ok(pos)
	assert.equal(pos.stopLoss, 24950)
	assert.ok(pos.stopLoss < pos.entryPrice)
	assert.equal(sends.length, 1)
	assert.equal(levelGeometryProblem({ side: 'SHORT', entry: pos.entryPrice, stop: pos.stopLoss, target: pos.target }), 'STOP_WRONG_SIDE')
})

test('proposed levelGeometryProblem: both sides, both levels, non-finite', () => {
	assert.equal(levelGeometryProblem({ side: 'LONG', entry: 100, stop: 99, target: 102 }), null)
	assert.equal(levelGeometryProblem({ side: 'SHORT', entry: 100, stop: 101, target: 98 }), null)
	assert.equal(levelGeometryProblem({ side: 'LONG', entry: 100, stop: 100, target: 102 }), 'STOP_WRONG_SIDE')
	assert.equal(levelGeometryProblem({ side: 'SHORT', entry: 100, stop: 99, target: 98 }), 'STOP_WRONG_SIDE')
	assert.equal(levelGeometryProblem({ side: 'LONG', entry: 100, stop: 99, target: 100 }), 'TARGET_WRONG_SIDE')
	assert.equal(levelGeometryProblem({ side: 'SHORT', entry: 100, stop: 101, target: 103 }), 'TARGET_WRONG_SIDE')
	assert.equal(levelGeometryProblem({ side: 'LONG', entry: Number.NaN, stop: 99, target: 102 }), 'NON_FINITE')
})

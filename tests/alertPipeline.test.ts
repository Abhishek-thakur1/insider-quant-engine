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

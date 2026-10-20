// ============================================================
// tests/legacyWorkerParity.test.ts — old worker vs new worker, executed
//
// Runs the ACTUAL pre-hook sendTelegramAlert (commit 437665b, vendored at
// tests/fixtures/telegramWorker.pre-signals.txt) side by side with the CURRENT
// src/workers/telegramWorker.ts (signals hook live) for every scenario in
// helpers/workerScenarios.ts. Only I/O imports are redirected to fakes
// (helpers/legacyHarness.ts); both function bodies run unmodified.
//
// Asserts: identical recorded side effects (filter calls, trades registered,
// Redis policy ops, Telegram sends, admin notices, console output), and that
// the new worker logged exactly one signals row per fire.
//
// The fixture is pinned (not read from the moving v2 branch) so this keeps
// testing against the pre-hook code after the feature merges. A separate test
// checks the fixture is byte-identical to the git object when git is available.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

import {
	equity,
	makeDeps,
	captureRun,
	scenarios,
	type Effect,
	type Scenario,
} from './helpers/workerScenarios.js'
import { loadWorker, rewriteImports, state, useDeps } from './helpers/legacyHarness.js'

const PRE_HOOK_COMMIT = '437665b'
const FIXTURE = new URL('./fixtures/telegramWorker.pre-signals.txt', import.meta.url)
const oldSource = fs.readFileSync(FIXTURE, 'utf8')
const newSource = fs.readFileSync(
	new URL('../src/workers/telegramWorker.ts', import.meta.url),
	'utf8',
)

const norm = (s: string) => s.replace(/\r\n/g, '\n')

test(`fixture is byte-identical to src/workers/telegramWorker.ts at ${PRE_HOOK_COMMIT}`, (t) => {
	let blob: string
	try {
		blob = execFileSync('git', ['show', `${PRE_HOOK_COMMIT}:src/workers/telegramWorker.ts`], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		})
	} catch {
		t.skip('git or the pinned commit is unavailable here')
		return
	}
	assert.equal(norm(oldSource), norm(blob))
})

test('only I/O imports are faked, in both versions', () => {
	const oldFaked = rewriteImports(norm(oldSource)).faked.sort()
	assert.deepEqual(oldFaked, [
		'../config/env.js',
		'../config/redis.js',
		'../core/positionTracker.js',
		'../detectors/janeStreetFilter.js',
		'telegraf',
	])
	const newFaked = rewriteImports(norm(newSource)).faked.sort()
	assert.deepEqual(newFaked, [
		'../config/env.js',
		'../config/redis.js',
		'../core/positionTracker.js',
		'../db/signalLog.js',
		'../detectors/janeStreetFilter.js',
		'telegraf',
	])
})

const runWorker = async (label: string, source: string, sc: Scenario) => {
	const worker = await loadWorker(label, source, !!sc.shadowMode)
	const effects: Effect[] = []
	await useDeps(makeDeps(sc, effects))
	await captureRun(effects, () => worker.sendTelegramAlert(sc.payload ?? equity))
	return { effects, signalRows: [...state.signalRows] }
}

for (const sc of scenarios) {
	test(`parity (old 437665b vs new worker): ${sc.name}`, async () => {
		const before = await runWorker('pre-signals', oldSource, sc)
		const after = await runWorker('current', newSource, sc)

		assert.ok(before.effects.length > 0, 'old worker produced no effects — harness not wired')
		assert.deepEqual(after.effects, before.effects)

		// The old worker never logs signals; the new one logs exactly one row per fire.
		assert.equal(before.signalRows.length, 0)
		assert.equal(after.signalRows.length, 1)
		const delivered = before.effects.some((e) => e[0] === 'delivered')
		assert.equal(after.signalRows[0]!.alert_sent, delivered)
	})
}

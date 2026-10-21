// ============================================================
// tests/liveStack.test.ts — what actually runs live, and what the boot banner says
//
// Source checks of src/ingestion/websocket.ts (it can't be imported in tests: it
// boots the engine). The banner previously claimed "9 detectors" and a "Value
// Zone" Nifty detector; the live equity stack is 2 detectors and Value Zone is
// archived.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ws = fs
	.readFileSync('src/ingestion/websocket.ts', 'utf8')
	.split(/\r?\n/)
	.filter((l) => !l.trim().startsWith('//'))
	.join('\n')

test('equity stack: one factory with exactly Stock Momentum Breakout + VolatilityContraction, used at both wiring sites', () => {
	assert.match(ws, /const buildEquityStack = \(symbol: string\): IDetector\[\] => \[new StockMomentumBreakoutDetector\(symbol\), new VolatilityContraction\(symbol\)\]/)
	assert.match(ws, /const EQUITY_STACK_NAMES = \['Stock Momentum Breakout', 'Volatility Contraction'\] as const/)
	assert.equal(ws.match(/strategyRouter\.set\(symbol, buildEquityStack\(symbol\)\)/g)?.length, 2, 'boot + anomaly promotion')
	assert.equal(ws.match(/strategyRouter\.set\(/g)?.length, 2, 'no other wiring site')
	assert.doesNotMatch(ws, /GapAndGoMomentum/)
})

test('Nifty stack: the banner list is exactly the five detectors analyze() is called on', () => {
	const stack = ws.match(/const NIFTY_STACK = \[([^\]]+)\]/)![1]!.split(',').map((s) => s.trim())
	const called = [...ws.matchAll(/await (\w+)\.analyze\(liveTick\)/g)].map((m) => m[1]!).filter((n) => n !== 's')
	assert.deepEqual(stack, called)
	assert.equal(stack.length, 5)
})

test('banner: derived from the wired stacks — no "9 detectors", no "Value Zone"', () => {
	assert.match(ws, /Equity stack: \$\{EQUITY_STACK_NAMES\.length\} detectors/)
	assert.match(ws, /Nifty stack: \$\{NIFTY_STACK\.length\} detectors \(\$\{NIFTY_STACK\.map\(\(d\) => d\.name\)/)
	assert.doesNotMatch(ws, /9 detectors|Value Zone/)
})

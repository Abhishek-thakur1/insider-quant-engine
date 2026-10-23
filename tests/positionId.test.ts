// ============================================================
// tests/positionId.test.ts — unique position ids and row addressing (2026-10-22)
//
// Oct 22 11:06: Stock Momentum Breakout and VCP fired AEQUS LONG in the same millisecond.
// Both positions got id `trade_<ms>_NSE:AEQUS-EQ`; the second overwrote the first in the
// Redis hash trades:open, and after the 11:46 restart only one was reloaded (pnl:daily
// counted one close). Postgres closed rows by symbol + entry_time, matching BOTH rows.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { newPositionId, rowMatch } from '../src/core/positionStatus.js'
import { runAlertPipeline, type PipelineDeps } from '../src/workers/alertPipeline.js'
import type { OpenPosition } from '../src/core/positionTracker.js'
import { NOW, MAX, decision, equity } from './helpers/workerScenarios.js'

test('ID SHAPE: trade_<ms>_<symbol>_<detector slug>_<6 hex>; detector slug strips punctuation', () => {
	const id = newPositionId(1792658635160, 'NSE:AEQUS-EQ', 'Volatility_Contraction_V2', () => 'a1b2c3')
	assert.equal(id, 'trade_1792658635160_NSE:AEQUS-EQ_VolatilityContractionV2_a1b2c3')
	assert.match(newPositionId(1, 'NIFTY 22650 CE', 'Delta Hedging Pressure (Gamma Squeeze)'), /^trade_1_NIFTY 22650 CE_DeltaHedgingPressureGamm_[0-9a-f]{6}$/)
	assert.match(newPositionId(1, 'X', ''), /_UNKNOWN_[0-9a-f]{6}$/)
})

test('SAME MILLISECOND, SAME SYMBOL: two fires through the real pipeline get distinct ids and both survive in a trades:open-style hash', async () => {
	const hash = new Map<string, OpenPosition>() // stands in for Redis HSET trades:open <id>
	const deps: PipelineDeps = {
		runFilter: async () => decision(),
		getTracker: async () => ({
			getCurrentNotional: () => 0,
			registerTrade: async (pos) => {
				hash.set(pos.id, pos)
				return hash.size
			},
		}),
		getAlertStore: async () => {
			const kv = new Map<string, string>()
			return {
				set: async (k, v, o) => (o.NX && kv.has(k) ? null : (kv.set(k, v), 'OK')),
				incr: async () => 1,
				decr: async () => 0,
				expire: async () => 1,
				del: async () => 1,
			}
		},
		sendChannel: async () => {},
		sendAdmin: async () => {},
		now: () => NOW, // the SAME millisecond for both
		config: { shadowMode: false, maxAlertsPerDay: MAX, capitalBase: 100000, capitalBehavior: 'REDUCE', hasAdmin: false },
	}
	const quiet = { log: console.log, warn: console.warn, error: console.error }
	console.log = console.warn = console.error = () => {}
	try {
		await Promise.all([
			runAlertPipeline({ ...equity, symbol: 'NSE:AEQUS-EQ', detectorName: 'Stock Momentum Breakout' }, deps),
			runAlertPipeline({ ...equity, symbol: 'NSE:AEQUS-EQ', detectorName: 'Volatility_Contraction_V2' }, deps),
		])
		// same detector twice in the same ms: the random suffix still separates them
		await Promise.all([runAlertPipeline({ ...equity, symbol: 'NSE:X-EQ' }, deps), runAlertPipeline({ ...equity, symbol: 'NSE:X-EQ' }, deps)])
	} finally {
		Object.assign(console, quiet)
	}
	assert.equal(hash.size, 4, `ids: ${[...hash.keys()].join(', ')}`)
	for (const id of hash.keys()) assert.ok(id.startsWith(`trade_${NOW}_`))
})

test('ROW ADDRESSING: with the row id known, UPDATEs target exactly that row; legacy positions keep symbol + entry_time', () => {
	assert.deepEqual(rowMatch({ dbId: 1592, symbol: 'NSE:AEQUS-EQ', timestamp: NOW }, 6), { where: 'id = $6', params: [1592] })
	assert.deepEqual(rowMatch({ symbol: 'NSE:AEQUS-EQ', timestamp: NOW }, 6), {
		where: 'symbol = $6 AND entry_time = to_timestamp($7 / 1000.0)',
		params: ['NSE:AEQUS-EQ', NOW],
	})
	assert.deepEqual(rowMatch({ dbId: null, symbol: 'S', timestamp: 1 }, 1).where, 'symbol = $1 AND entry_time = to_timestamp($2 / 1000.0)')
})

test('WIRING: the tracker persists dbId after INSERT and both UPDATEs go through rowMatch; nothing parses the id', () => {
	const tracker = fs.readFileSync('src/core/positionTracker.ts', 'utf8')
	// ORDER (review of 145c5ba, blocking): INSERT → dbId → ONE hSet → addToMemory. A position is
	// invisible to processTick until its row id is known, so a close can't race the INSERT and no
	// second write can resurrect a closed position.
	const reg = tracker.slice(tracker.indexOf('public async registerTrade'), tracker.indexOf('// Publish signal_event for open'))
	const at = (re: RegExp) => reg.search(re)
	const insert = at(/INSERT INTO paper_trades/)
	const setDbId = at(/pos\.dbId = tradeId/)
	const hset = at(/redisClient\.hSet\('trades:open'/)
	const mem = at(/this\.addToMemory\(pos\)/)
	assert.ok(insert > 0 && insert < setDbId && setDbId < hset && hset < mem, `order INSERT(${insert}) < dbId(${setDbId}) < hSet(${hset}) < addToMemory(${mem})`)
	assert.equal((reg.match(/redisClient\.hSet\('trades:open'/g) ?? []).length, 1, 'exactly one trades:open write per registration')
	assert.equal((tracker.match(/rowMatch\(pos, /g) ?? []).length, 2, 'close and orphan UPDATEs')
	assert.doesNotMatch(tracker, /WHERE symbol = \$\d+ AND status IN/, 'no UPDATE matches by symbol + entry_time directly')
	// the id is only ever used as an opaque key (hSet/hDel/hKeys) — never split or pattern-matched
	for (const f of ['src/core/positionTracker.ts', 'src/api/server.ts', 'src/workers/alertPipeline.ts']) {
		const src = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '')
		assert.doesNotMatch(src, /\.id\.(split|match|replace|slice|startsWith)\(|trade_\\d|\/\^trade_/, `${f} parses the position id`)
	}
})

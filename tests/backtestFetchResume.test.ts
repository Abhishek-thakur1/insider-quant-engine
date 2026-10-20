// ============================================================
// tests/backtestFetchResume.test.ts — the evidence-run fetch survives a token expiry
//
// Runs the real backtest fetcher (backtest/data/fyersClient.ts + store.ts) against
// a fake Fyers in a TEMP working directory (the cache never touches the repo):
//   run 1: the token "expires" mid-run → the fetch stops at once (no cascade of
//          per-symbol failures), with everything fetched so far on disk;
//   run 2: fresh token, same command → only the missing chunks are requested,
//          and the final cache is identical to one uninterrupted run.
// Plus the market-hours guard.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-resume-'))
const repoRoot = process.cwd()
process.chdir(work) // DATA_DIR is resolved from cwd at import time
process.env.TELEGRAM_BOT_TOKEN ??= 'test'
process.env.TELEGRAM_CHANNEL_ID ??= 'test'
process.env.FYERS_APP_ID ??= 'test'
process.env.FYERS_SECRET_ID ??= 'test'

await import('../backtest/core/bootEnv.js')
const client = await import('../backtest/data/fyersClient.js')
const store = await import('../backtest/data/store.js')
const { marketWindowViolation } = await import('../backtest/marketWindow.js')
process.chdir(repoRoot)

const DAY = 86_400_000
const FROM = Date.parse('2024-01-01T00:00:00Z')
const TO = Date.parse('2026-03-01T00:00:00Z') // ~790 days → 3 daily chunks of 365
const SYMBOLS = ['NSE:A-EQ', 'NSE:B-EQ', 'NSE:C-EQ', 'NSE:D-EQ', 'NSE:E-EQ']
const IST = 5.5 * 3600e3

/** Weekday daily candles for every symbol; NSE:E-EQ "lists" only in 2025 (pre-listing chunk returns nothing). */
const fakeFyers = (failAfterCalls = Infinity) => {
	const calls: string[] = []
	const fn = async (req: { symbol: string; range_from: string; range_to: string }) => {
		calls.push(`${req.symbol} ${req.range_from}..${req.range_to}`)
		if (calls.length > failAfterCalls) throw { code: -16, message: 'Could not authenticate the user', s: 'error' }
		const candles: number[][] = []
		const listed = req.symbol === 'NSE:E-EQ' ? Date.parse('2025-06-02T00:00:00Z') : 0
		for (let t = Date.parse(`${req.range_from}T00:00:00Z`); t <= Date.parse(`${req.range_to}T00:00:00Z`); t += DAY) {
			const wd = new Date(t).getUTCDay()
			if (wd === 0 || wd === 6 || t < listed) continue
			candles.push([(t - IST) / 1000, 100, 101, 99, 100.5, 1000])
		}
		return candles.length ? { s: 'ok', candles } : { s: 'no_data', candles: [] }
	}
	return { calls, fn }
}

const cacheDir = path.join(work, 'backtest', 'data', 'cache', 'res-D')
const snapshot = () =>
	Object.fromEntries(SYMBOLS.map((s) => [s, store.loadSeries(s, 'D')?.bars.map((b) => b.t) ?? []]))
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
	const [log, warn, error] = [console.log, console.warn, console.error]
	const errors: string[] = []
	console.log = () => {}
	console.warn = () => {}
	console.error = (...a: unknown[]) => void errors.push(a.join(' '))
	try {
		return await fn()
	} finally {
		Object.assign(console, { log, warn, error })
		;(quiet as unknown as { last: string[] }).last = errors
	}
}
const inWork = async <T>(fn: () => Promise<T>): Promise<T> => {
	process.chdir(work)
	try {
		return await fn()
	} finally {
		process.chdir(repoRoot)
	}
}

test('auth errors are recognised (-16 / -17 / 401 / message); rate limits are not', () => {
	assert.equal(client.isAuthError({ code: -16, message: 'Could not authenticate the user' }), true)
	assert.equal(client.isAuthError({ code: -17, message: 'x' }), true)
	assert.equal(client.isAuthError({ response: { status: 401 } }), true)
	assert.equal(client.isAuthError(new Error('Your token has expired')), true)
	assert.equal(client.isAuthError({ code: -360, message: "You've reached the Standard plan limit of 5 requests/second" }), false)
})

test('TOKEN EXPIRY then RESUME: run 1 stops at the expiry with progress saved; run 2 fetches only what is missing; result = one clean run', async () => {
	// Reference: one uninterrupted run in its own cache.
	fs.rmSync(path.join(work, 'backtest'), { recursive: true, force: true })
	const clean = fakeFyers()
	client.__setHistoryFnForTests(clean.fn)
	await inWork(() => quiet(() => client.fetchUniverse(SYMBOLS, 'D', FROM, TO, { skipAuth: true })))
	const reference = snapshot()
	const totalCalls = clean.calls.length
	assert.equal(totalCalls, 15, '5 symbols × 3 chunks')

	// Run 1: token dies after 7 successful calls (A, B complete; C has 1 of 3 chunks).
	fs.rmSync(path.join(work, 'backtest'), { recursive: true, force: true })
	const r1 = fakeFyers(7)
	client.__setHistoryFnForTests(r1.fn)
	await assert.rejects(
		inWork(() => quiet(() => client.fetchUniverse(SYMBOLS, 'D', FROM, TO, { skipAuth: true }))),
		(e: unknown) => e instanceof client.TokenExpiredError,
	)
	assert.equal(r1.calls.length, 8, 'stopped at the first rejected call — no cascade over the remaining symbols')
	assert.ok((quiet as unknown as { last: string[] }).last.join('\n').includes('rerun the SAME command'))
	const partial = snapshot()
	assert.deepEqual(partial['NSE:A-EQ'], reference['NSE:A-EQ'])
	assert.deepEqual(partial['NSE:B-EQ'], reference['NSE:B-EQ'])
	assert.ok(partial['NSE:C-EQ']!.length > 0 && partial['NSE:C-EQ']!.length < reference['NSE:C-EQ']!.length, 'C partially saved')
	assert.equal(partial['NSE:D-EQ']!.length, 0)

	// Run 2: fresh token, same command.
	const r2 = fakeFyers()
	client.__setHistoryFnForTests(r2.fn)
	await inWork(() => quiet(() => client.fetchUniverse(SYMBOLS, 'D', FROM, TO, { skipAuth: true })))
	assert.equal(r2.calls.length, totalCalls - 7, `only the 8 missing chunks: ${r2.calls.join(' | ')}`)
	assert.ok(!r2.calls.some((c) => c.startsWith('NSE:A-EQ') || c.startsWith('NSE:B-EQ')), 'completed symbols not refetched')
	assert.deepEqual(snapshot(), reference, 'final cache identical to an uninterrupted run')

	// Run 3, same window: nothing left to fetch — including the pre-listing chunk of E that returned no bars.
	const r3 = fakeFyers()
	client.__setHistoryFnForTests(r3.fn)
	await inWork(() => quiet(() => client.fetchUniverse(SYMBOLS, 'D', FROM, TO, { skipAuth: true })))
	assert.deepEqual(r3.calls, [])
	assert.ok(fs.existsSync(path.join(cacheDir, 'NSE_E-EQ.coverage.json')))
	client.__setHistoryFnForTests(null)
})

test('coverage union: shifted chunk edges on a later run are still recognised as covered', () => {
	const merged = store.mergeRanges([[0, 10], [10, 20], [30, 40], [5, 12]])
	assert.deepEqual(merged, [[0, 20], [30, 40]])
	assert.equal(store.isCovered(merged, 3, 19), true)
	assert.equal(store.isCovered(merged, 15, 35), false)
})

test('market-hours guard: blocked 08:45–15:45 and 16:25–17:05 IST on trading days only', () => {
	const ist = (day: string, h: number, m: number) => Date.parse(`${day}T00:00:00Z`) + (h * 60 + m) * 60e3 - IST
	const holidays = new Set(['2026-11-10'])
	assert.match(marketWindowViolation(ist('2026-10-21', 10, 0), holidays)!, /blocked 08:45–15:45 IST \(engine boot and live session\)/)
	assert.match(marketWindowViolation(ist('2026-10-21', 16, 30), holidays)!, /blocked 16:25–17:05 IST \(the 16:30 EOD screener job\)/)
	assert.equal(marketWindowViolation(ist('2026-10-21', 16, 0), holidays), null, 'between session and screener')
	assert.equal(marketWindowViolation(ist('2026-10-21', 17, 5), holidays), null)
	assert.match(marketWindowViolation(ist('2026-10-21', 8, 45), holidays)!, /08:45 IST/)
	assert.equal(marketWindowViolation(ist('2026-10-21', 8, 44), holidays), null)
	assert.equal(marketWindowViolation(ist('2026-10-21', 15, 45), holidays), null)
	assert.equal(marketWindowViolation(ist('2026-10-24', 11, 0), holidays), null, 'Saturday')
	assert.equal(marketWindowViolation(ist('2026-11-10', 11, 0), holidays), null, 'holiday')
	const run = fs.readFileSync('backtest/run.ts', 'utf8')
	assert.match(run, /\['fetch', 'fetch-daily-all', 'fetch-intraday'\]\.includes\(cmd \?\? ''\) && !rest\.includes\('--allow-market-hours'\)/)
})

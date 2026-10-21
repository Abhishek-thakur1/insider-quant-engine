// tests/fullReportStats.test.ts — the statistics behind every number in the full report
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TELEGRAM_BOT_TOKEN ??= 'test'
process.env.TELEGRAM_CHANNEL_ID ??= 'test'
process.env.FYERS_APP_ID ??= 'test'
process.env.FYERS_SECRET_ID ??= 'test'
const { dayBlockCI, summarizeTrades, MIN_N } = await import('../backtest/fullReport.js')

const tr = (r: number, day: number, hold = 60, k = 0) => ({ r, sessionDate: `2026-01-${String(day).padStart(2, '0')}`, entryTs: day * 1e6 + k, holdingMinutes: hold })

test('summary: n, win rate, E[R], PF, max drawdown, best/worst, holding quantiles, n<30 flag', () => {
	const trades = [tr(2, 1, 30), tr(-1, 1, 60, 1), tr(-1, 2, 90), tr(1.5, 3, 120), tr(-0.5, 4, 240)]
	const s = summarizeTrades(trades)
	assert.equal(s.n, 5)
	assert.equal(s.winRate, 0.4)
	assert.equal(s.expectancyR, 0.2)
	assert.equal(Number(s.profitFactor!.toFixed(4)), Number((3.5 / 2.5).toFixed(4)))
	assert.equal(s.maxDrawdownR, 2) // +2, +1, 0 → peak 2, trough 0
	assert.deepEqual([s.bestR, s.worstR], [2, -1])
	assert.deepEqual([s.hold!.p25, s.hold!.p50, s.hold!.max], [60, 90, 240])
	assert.equal(s.tradeDays, 4)
	assert.equal(s.sufficient, false)
	assert.equal(MIN_N, 30)
	assert.equal(summarizeTrades(Array.from({ length: 30 }, (_, i) => tr(0.1, (i % 28) + 1))).sufficient, true)
})

test('day-block CI: deterministic, brackets the mean, null with one trade day', () => {
	const trades = Array.from({ length: 200 }, (_, i) => tr(((i * 7919) % 13) / 4 - 1.2, (i % 25) + 1, 60, i))
	const a = dayBlockCI(trades)!
	const b = dayBlockCI(trades)!
	assert.deepEqual(a, b, 'fixed seed')
	const mean = trades.reduce((x, t) => x + t.r, 0) / trades.length
	assert.ok(a[0] < mean && mean < a[1], `${a} vs ${mean}`)
	assert.equal(dayBlockCI([tr(1, 3), tr(2, 3, 60, 1)]), null)
})

test('day-block CI is wider than a naive per-trade CI when trades cluster by day', () => {
	// 20 days; each day's trades share one outcome → strongly correlated within a day
	const trades = Array.from({ length: 20 }, (_, d) => Array.from({ length: 10 }, (_, k) => tr(d % 2 ? 1 : -0.8, d + 1, 60, k))).flat()
	const [lo, hi] = dayBlockCI(trades)!
	const sd = Math.sqrt(trades.reduce((x, t) => x + (t.r - 0.1) ** 2, 0) / trades.length)
	const naiveHalf = (1.96 * sd) / Math.sqrt(trades.length)
	assert.ok(hi - lo > 2 * naiveHalf * 2, `day-block width ${hi - lo} vs naive ${2 * naiveHalf}`)
})

test('caveat shown next to every result states the look-ahead universe, the 2,000 resamples and the "not trusted" rule', async () => {
	const { CAVEAT_EQUITY, CAVEAT_NIFTY } = await import('../backtest/fullReport.js')
	assert.match(CAVEAT_EQUITY, /chosen in July 2026 and replayed back to 2021 — look-ahead and survivorship-biased/)
	assert.match(CAVEAT_EQUITY, /2,000 resamples/)
	assert.match(CAVEAT_EQUITY, /A positive result on this universe would NOT be trusted\./)
	assert.match(CAVEAT_NIFTY, /index points, not option premium/)
	assert.match(CAVEAT_NIFTY, /2,000 resamples/)
	const src = (await import('node:fs')).readFileSync('backtest/fullReport.ts', 'utf8')
	assert.ok((src.match(/caveatP\(|caveatFor\(/g) ?? []).length >= 12, 'caveat rendered at every table and card')
})

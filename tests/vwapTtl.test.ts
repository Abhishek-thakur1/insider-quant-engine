// ============================================================
// tests/vwapTtl.test.ts — the daily VWAP keys expire (2026-10-27).
//
// vwap:{symbol}:{date} had no TTL, so every symbol-day ever seen stayed in Redis (4,485 keys on
// 26 Oct). Both writers — updateVwap (live ticks) and the seeder — now set VWAP_TTL_SECS (36 h).
// In-memory Redis on the virtual clock; no network.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'

const clock = await import('../backtest/core/clock.js')
const { installMemoryRedis } = await import('../backtest/core/memoryRedis.js')
const { redisClient } = await import('../src/config/redis.js')
const { updateVwap, getVwap, VWAP_TTL_SECS } = await import('../src/utils/vwapUtils.js')

test('VWAP TTL: a live-tick VWAP key expires 36 h after its last write, and is readable until then', async () => {
	assert.equal(VWAP_TTL_SECS, 36 * 3600)
	const t0 = clock.istEpoch('2026-10-27', 9 * 60 + 15)
	const uninstallClock = clock.installVirtualClock(t0)
	const { uninstall } = installMemoryRedis()
	try {
		await updateVwap('NSE:TTL-EQ', 100, 10)
		clock.setVirtualNow(t0 + 6 * 3600_000) // 15:15 the same day: refreshed by the next write
		await updateVwap('NSE:TTL-EQ', 102, 10)
		assert.equal(await getVwap('NSE:TTL-EQ'), 101)
		const key = 'vwap:NSE:TTL-EQ:2026-10-27'
		const lastWrite = t0 + 6 * 3600_000
		clock.setVirtualNow(lastWrite + VWAP_TTL_SECS * 1000 - 1000)
		assert.ok(await redisClient.get(key), 'still present 1 s before expiry')
		clock.setVirtualNow(lastWrite + VWAP_TTL_SECS * 1000 + 1000)
		assert.equal(await redisClient.get(key), null, 'expired after the TTL')
	} finally {
		uninstall()
		uninstallClock()
	}
})

test('VWAP TTL: the seeder writes its key with the same TTL (source check)', async () => {
	const fs = await import('node:fs')
	const src = fs.readFileSync('src/ingestion/vwapSeeder.ts', 'utf8')
	const live = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
	assert.match(live, /redisClient\.setEx\(`vwap:\$\{symbol\}:\$\{todayStr\}`, VWAP_TTL_SECS,/)
	assert.doesNotMatch(live, /redisClient\.set\(`vwap:/)
})

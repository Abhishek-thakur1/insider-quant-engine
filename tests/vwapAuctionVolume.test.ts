// ============================================================
// tests/vwapAuctionVolume.test.ts — the pre-open auction volume stays out of the equity VWAP (2026-11-03).
//
// Real 3 Nov ticks, from the engine log heartbeat samples:
//   - 09:00–09:05: equity ticks carry no volume field (9,839 of 9,839), so the volume baseline is 0;
//   - nothing from 09:09:18 until 09:15:00;
//   - TATASTEEL, received 09:15:00 (exch_feed_time 1793677500): last_traded_time 1793677133 = 09:08:53,
//     vol_traded_today 136,578 — the auction, and nothing else.
// Before this fix the gate used the receive time, so those 136,578 shares entered the VWAP.
// Path under test: tickVolumeDelta (the handler's volume diff) → updateSessionVwap (the equity VWAP gate).
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHANNEL_ID ??= '-1000000000000'
process.env.FYERS_APP_ID ??= 'TEST-APP-ID'
process.env.FYERS_SECRET_ID ??= 'test-secret'
process.env.FYERS_REDIRECT_URI ??= 'http://localhost:3000/callback'
process.env.BACKTEST_MODE = 'true'

const clock = await import('../backtest/core/clock.js')
const { installMemoryRedis } = await import('../backtest/core/memoryRedis.js')
const { redisClient } = await import('../src/config/redis.js')
const { tickVolumeDelta, updateSessionVwap, vwapStampMs } = await import('../src/utils/vwapUtils.js')

const DATE = '2026-11-03'
const SYM = 'NSE:TATASTEEL-EQ'
const at = (h: number, m: number, s = 0) => clock.istEpoch(DATE, h * 60 + m) + s * 1000
const AUCTION_LTT = 1793677133 // 09:08:53 IST, as logged
const AUCTION_RECEIVED = 1793677500 * 1000 // 09:15:00 IST (exch_feed_time)
const AUCTION_VOL = 136_578
const YESTERDAY_LTT = 1793615325 // a pre-open tick's last trade (2 Nov), as logged for MRPL

type Tick = { receivedMs: number; ltp: number; vol?: number; ltt?: number }
/** 3 Nov morning for TATASTEEL: pre-open ticks without volume, the auction tick at 09:15:00, then two trades. */
const morning: Tick[] = [
	{ receivedMs: at(9, 1), ltp: 179.2, ltt: YESTERDAY_LTT }, // pre-open, no volume field
	{ receivedMs: at(9, 6), ltp: 179.0, ltt: YESTERDAY_LTT }, // pre-open, no volume field
	{ receivedMs: AUCTION_RECEIVED, ltp: 179.0, vol: AUCTION_VOL, ltt: AUCTION_LTT }, // the auction, after the open
	{ receivedMs: at(9, 15, 1), ltp: 179.1, vol: AUCTION_VOL + 1_000, ltt: Math.floor(at(9, 15, 1) / 1000) },
	{ receivedMs: at(9, 15, 3), ltp: 179.3, vol: AUCTION_VOL + 3_000, ltt: Math.floor(at(9, 15, 3) / 1000) },
]

/** The handler: volume diff, zero-volume ticks dropped, then the VWAP gate. `useLtt` false = the old receive-time gate. */
const run = async (gate: boolean, useLtt: boolean) => {
	const prev = process.env.VWAP_SESSION_GATE
	process.env.VWAP_SESSION_GATE = gate ? 'true' : 'false'
	const uninstallClock = clock.installVirtualClock(at(9, 0))
	const { uninstall } = installMemoryRedis()
	try {
		const tracker = new Map<string, number>()
		for (const t of morning) {
			clock.setVirtualNow(t.receivedMs)
			const vol = tickVolumeDelta(tracker, SYM, t.vol)
			if (vol <= 0) continue // websocket.ts drops zero-volume equity ticks
			await updateSessionVwap(SYM, t.ltp, vol, t.receivedMs, useLtt ? t.ltt : undefined)
		}
		return JSON.parse((await redisClient.get(`vwap:${SYM}:${DATE}`)) ?? 'null') as { cumulativeVol: number; vwap: number } | null
	} finally {
		uninstall()
		uninstallClock()
		if (prev === undefined) delete process.env.VWAP_SESSION_GATE
		else process.env.VWAP_SESSION_GATE = prev
	}
}

test('fixture: the logged times are what the comments say', () => {
	assert.equal(new Date(AUCTION_LTT * 1000 + 5.5 * 3_600_000).toISOString().slice(11, 19), '09:08:53')
	assert.equal(new Date(AUCTION_RECEIVED + 5.5 * 3_600_000).toISOString().slice(0, 19), '2026-11-03T09:15:00')
})

test('the bug (old receive-time gate): the 136,578-share auction enters the VWAP', async () => {
	const s = await run(true, false)
	assert.equal(s!.cumulativeVol, AUCTION_VOL + 3_000)
})

test('the fix: gated on last-trade time, only the 3,000 shares traded from 09:15 count', async () => {
	const s = await run(true, true)
	assert.equal(s!.cumulativeVol, 3_000, 'the auction volume became the baseline, not VWAP volume')
	assert.equal(s!.vwap.toFixed(4), ((179.1 * 1_000 + 179.3 * 2_000) / 3_000).toFixed(4))
})

test('kill switch VWAP_SESSION_GATE=false: every tick counts, as before', async () => {
	assert.equal((await run(false, true))!.cumulativeVol, AUCTION_VOL + 3_000)
	assert.equal((await run(false, false))!.cumulativeVol, AUCTION_VOL + 3_000)
})

test('vwapStampMs: last-trade time when valid and same IST day; receive time when missing; null on another day', () => {
	const recv = AUCTION_RECEIVED
	assert.equal(vwapStampMs(AUCTION_LTT, recv), AUCTION_LTT * 1000)
	assert.equal(vwapStampMs(String(AUCTION_LTT), recv), AUCTION_LTT * 1000, 'numeric strings are accepted')
	assert.equal(vwapStampMs(undefined, recv), recv)
	assert.equal(vwapStampMs(null, recv), recv)
	assert.equal(vwapStampMs(0, recv), recv)
	assert.equal(vwapStampMs('x', recv), recv)
	assert.equal(vwapStampMs(YESTERDAY_LTT, recv), null, 'a last trade on another day never enters today')
})

test('boundary: a last trade at 09:14:59 stays out, 09:15:00 counts (gate on)', async () => {
	process.env.VWAP_SESSION_GATE = 'true'
	const uninstallClock = clock.installVirtualClock(at(9, 15, 5))
	const { uninstall } = installMemoryRedis()
	try {
		const recv = at(9, 15, 5)
		assert.equal(await updateSessionVwap(SYM, 100, 10, recv, Math.floor(at(9, 14, 59) / 1000)), null)
		assert.notEqual(await updateSessionVwap(SYM, 100, 10, recv, Math.floor(at(9, 15, 0) / 1000)), null)
		assert.equal(await updateSessionVwap(SYM, 100, 10, recv, YESTERDAY_LTT), null)
	} finally {
		uninstall()
		uninstallClock()
		delete process.env.VWAP_SESSION_GATE
	}
})

test('tickVolumeDelta: first tick is the baseline, a recorded 0 stays the baseline, never negative', () => {
	const m = new Map<string, number>()
	assert.equal(tickVolumeDelta(m, 'A', 500), 0, 'first sight: baseline only')
	assert.equal(tickVolumeDelta(m, 'A', 800), 300)
	assert.equal(tickVolumeDelta(m, 'A', 700), 0, 'a lower total never gives negative volume')
	assert.equal(m.get('A'), 700, 'the tracker still follows the feed')
	assert.equal(tickVolumeDelta(m, 'B', undefined), 0)
	assert.equal(tickVolumeDelta(m, 'B', 136_578), 136_578, 'after a no-volume tick the baseline is 0: the whole jump is volume')
})

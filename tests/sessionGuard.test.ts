// ============================================================
// tests/sessionGuard.test.ts — watchdog policy + NSE trading calendar
//
// Exercises the real src/core/sessionGuard.ts (pure) that websocket.ts uses on
// every watchdog check and trip, the real scheduler/nse_holidays.txt, and the
// real scheduler/trading_day.sh (when a POSIX sh is available).
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
	calendarMissingYear,
	checkWatchdog,
	decideTrip,
	MAX_RESTARTS_PER_DAY,
	parseHolidays,
	restartBackoffMs,
	restartCounterKey,
	tradingDayVerdict,
	WATCHDOG_TIMEOUT_MS,
} from '../src/core/sessionGuard.js'

const HOLIDAY_FILE = new URL('../scheduler/nse_holidays.txt', import.meta.url)
const holidays = parseHolidays(fs.readFileSync(HOLIDAY_FILE, 'utf8'))

/** IST wall clock → epoch ms */
const ist = (date: string, hh: number, mm: number, ss = 0) =>
	Date.parse(`${date}T00:00:00Z`) + ((hh * 60 + mm) * 60 + ss) * 1000 - 5.5 * 3600 * 1000

// ── Calendar ────────────────────────────────────────────────────────────────

test('holiday file: the 15 approved 2026 weekday holidays, nothing else', () => {
	assert.deepEqual([...holidays].sort(), [
		'2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03',
		'2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14',
		'2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
	])
	for (const d of holidays) {
		const wd = new Date(`${d}T00:00:00Z`).getUTCDay()
		assert.ok(wd >= 1 && wd <= 5, `${d} is a weekend — weekday holidays only`)
	}
	assert.ok(!holidays.has('2026-11-04') && !holidays.has('2026-11-05'), 'Nov 4/5 are trading days')
})

test('Oct 20 2026 (Dussehra) is a holiday; Oct 19 trades; weekends never trade', () => {
	assert.deepEqual(tradingDayVerdict('2026-10-20', holidays), { trading: false, reason: 'HOLIDAY' })
	assert.deepEqual(tradingDayVerdict('2026-10-19', holidays), { trading: true })
	assert.deepEqual(tradingDayVerdict('2026-10-24', holidays), { trading: false, reason: 'WEEKEND' })
	assert.deepEqual(tradingDayVerdict('2026-10-25', holidays), { trading: false, reason: 'WEEKEND' })
})

test('parser ignores comments, blanks and CRLF', () => {
	const h = parseHolidays('# header\r\n\r\n2026-10-20\r\n  2026-11-10  # Diwali\r\nnot-a-date\r\n')
	assert.deepEqual([...h], ['2026-10-20', '2026-11-10'])
})

test('a calendar with no entries for the current year is flagged as stale', () => {
	assert.equal(calendarMissingYear(holidays, '2026-10-21'), false)
	assert.equal(calendarMissingYear(holidays, '2027-01-04'), true)
})

const shAvailable = (() => {
	try {
		execFileSync('sh', ['-c', 'exit 0'])
		return true
	} catch {
		return false
	}
})()

test('scheduler/trading_day.sh agrees with the engine (every holiday ±1 day, all of Oct–Nov 2026)', { skip: !shAvailable && 'no POSIX sh' }, () => {
	const script = fileURLToPath(new URL('../scheduler/trading_day.sh', import.meta.url))
	const env = { ...process.env, NSE_HOLIDAY_FILE: fileURLToPath(HOLIDAY_FILE) }
	const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
	const set = new Set<string>()
	for (const h of holidays) for (const off of [-1, 0, 1]) set.add(day(Date.parse(`${h}T00:00:00Z`) + off * 86_400_000))
	for (let i = 0; i < 61; i++) set.add(day(Date.UTC(2026, 9, 1 + i)))
	const days = [...set].sort()
	// One sh process: print "<date> <exit code>" per day.
	const loop = 'script="$0"; for d in "$@"; do sh "$script" "$d" >/dev/null; echo "$d $?"; done'
	const out = execFileSync('sh', ['-c', loop, script, ...days], { env, encoding: 'utf8' }).trim().split('\n')
	assert.equal(out.length, days.length)
	let mismatches = 0
	for (const line of out) {
		const [date, code] = line.trim().split(' ')
		const v = tradingDayVerdict(date!, holidays)
		const expected = v.trading ? '0' : v.reason === 'WEEKEND' ? '1' : '2'
		if (code !== expected) mismatches++
	}
	assert.equal(mismatches, 0)
})

// ── Watchdog check (every 10 s) ─────────────────────────────────────────────

test('silence outside 09:15–15:30 IST resets the clock instead of tripping', () => {
	const stale = 10 * 60 * 1000
	assert.equal(checkWatchdog(ist('2026-10-19', 9, 0), ist('2026-10-19', 9, 0) - stale), 'RESET_CLOCK') // 09:00 boot
	assert.equal(checkWatchdog(ist('2026-10-19', 9, 14, 59), 0), 'RESET_CLOCK') // pre-open lull
	assert.equal(checkWatchdog(ist('2026-10-19', 15, 30), 0), 'RESET_CLOCK') // post-close
})

test('in session: 30 s of silence is OK, 31 s trips', () => {
	const now = ist('2026-10-19', 9, 16)
	assert.equal(checkWatchdog(now, now - WATCHDOG_TIMEOUT_MS), 'OK')
	assert.equal(checkWatchdog(now, now - WATCHDOG_TIMEOUT_MS - 1000), 'TRIP')
})

// ── Trip policy ─────────────────────────────────────────────────────────────

test('Oct 19 15:15:50 IST trip: stand down with exit 0 — no restart after 15:15', () => {
	const d = decideTrip(ist('2026-10-19', 15, 15, 50), 1)
	assert.equal(d.action, 'STAND_DOWN')
	assert.equal(d.exitCode, 0)
	assert.match(d.reason, /15:15/)
	// one second before the cutoff still restarts
	assert.equal(decideTrip(ist('2026-10-19', 15, 14, 59), 1).action, 'RESTART')
})

test('restart limit: trips 1–6 restart (exit 1), the 7th stands down (exit 0)', () => {
	const at = ist('2026-10-21', 10, 0)
	assert.equal(MAX_RESTARTS_PER_DAY, 6)
	for (let n = 1; n <= 6; n++) assert.deepEqual([decideTrip(at, n).action, decideTrip(at, n).exitCode], ['RESTART', 1], `trip ${n}`)
	assert.deepEqual([decideTrip(at, 7).action, decideTrip(at, 7).exitCode], ['STAND_DOWN', 0])
	assert.deepEqual([decideTrip(at, 50).action, decideTrip(at, 50).exitCode], ['STAND_DOWN', 0])
})

test('backoff before reconnecting: 0, 30 s, 60 s, 120 s, 240 s, then capped at 5 min', () => {
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map(restartBackoffMs), [0, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000])
})

test('restart counter is per IST day (a new day starts at zero)', () => {
	assert.equal(restartCounterKey(ist('2026-10-21', 9, 30)), 'engine:restarts:2026-10-21')
	assert.equal(restartCounterKey(ist('2026-10-21', 23, 59)), 'engine:restarts:2026-10-21')
	assert.equal(restartCounterKey(ist('2026-10-22', 0, 1)), 'engine:restarts:2026-10-22')
})

test('Oct 20 replay: a socket silent all session now costs at most 6 restarts, not 415', () => {
	// If the engine ever ran on a silent day (e.g. a calendar gap), simulate the
	// loop: trip → (exit 1 → Docker restart → backoff → reconnect → 30 s silence) …
	const BOOT_MS = 60_000 // screener skip + seeder skip + subscribe, generous
	let t = ist('2026-10-20', 9, 15)
	let trips = 0
	const exits: number[] = []
	for (;;) {
		t += WATCHDOG_TIMEOUT_MS + 10_000 // first check after >30 s silence
		trips++
		const d = decideTrip(t, trips)
		exits.push(d.exitCode)
		if (d.action === 'STAND_DOWN') break
		t += restartBackoffMs(trips) + BOOT_MS
	}
	assert.deepEqual(exits, [1, 1, 1, 1, 1, 1, 0])
	assert.ok(t < ist('2026-10-20', 10, 0), 'stands down well before 10:00')
})

test('lastCompletedSession: the screener screens the last session whose daily bar is complete', async () => {
	const { lastCompletedSession } = await import('../src/core/sessionGuard.js')
	// Tue 2026-10-20 (Dussehra) 20:53 — the manual run tonight → Mon 19th
	assert.equal(lastCompletedSession(ist('2026-10-20', 20, 53), holidays), '2026-10-19')
	// Wed 21st 08:15, before the open → still Mon 19th (the 20th is a holiday)
	assert.equal(lastCompletedSession(ist('2026-10-21', 8, 15), holidays), '2026-10-19')
	// Wed 21st 15:29 → not complete yet; 15:30 and the 16:30 cron run → the 21st
	assert.equal(lastCompletedSession(ist('2026-10-21', 15, 29), holidays), '2026-10-19')
	assert.equal(lastCompletedSession(ist('2026-10-21', 15, 30), holidays), '2026-10-21')
	assert.equal(lastCompletedSession(ist('2026-10-21', 16, 30), holidays), '2026-10-21')
	// Saturday / Monday morning → Friday
	assert.equal(lastCompletedSession(ist('2026-10-24', 11, 0), holidays), '2026-10-23')
	assert.equal(lastCompletedSession(ist('2026-10-26', 8, 0), holidays), '2026-10-23')
})

// ============================================================
// backtest/core/clock.ts — virtual clock (time virtualization)
//
// THE PROBLEM THIS SOLVES — read this before changing anything here.
//
// The detectors do NOT take time as a parameter. They read the wall clock
// directly, in two places that both decide whether a signal can fire at all:
//
//   1. Trading-window gates. Every detector has some variant of
//        const getISTMinutes = () => {
//          const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
//          return d.getUTCHours() * 60 + d.getUTCMinutes()
//        }
//        const isActiveWindow = () => m >= 9*60+15 && m <= 14*60+45
//      If we replay a historical session at 03:00 IST, `isActiveWindow()`
//      returns false on every tick and NOTHING fires. The backtest would
//      silently report zero signals for every detector and look "done".
//
//   2. VWAP day keys. `vwapUtils` derives `vwap:{symbol}:{YYYY-MM-DD}` from
//      Date.now(). Without virtualization every replayed day would accumulate
//      into today's real key, so day 1 and day 60 of the backtest would share
//      one VWAP accumulator.
//
// Redis TTLs have the same problem and are handled in memoryRedis.ts, which
// reads this same clock: cooldowns are `setEx(key, 1800, …)`. Replaying a
// session takes seconds of wall time, so a wall-clock TTL would never expire
// and each detector would fire at most once per backtest run.
//
// SO: we replace the global time source for the duration of a replay. This
// touches zero files under src/ — it is the least invasive way to make
// wall-clock-reading code deterministic, and it is standard practice in
// backtest harnesses.
//
// COVERAGE: `Date.now()` is the dominant path. `new Date()` with no arguments
// also appears in the codebase (optionUtils.getNextThursday's default
// parameter, tradeLogger's timestamp), so the Date constructor is patched too.
// Every other construction in the codebase passes an explicit argument
// (`new Date(liveTick.timestamp + …)`) and is unaffected either way.
// ============================================================

let virtualNow = 0
let installed = false

const RealDate = Date
type DateCtor = typeof Date

/** Advance (or set) the simulated clock. Called by the replay engine per bar. */
export const setVirtualNow = (epochMs: number): void => {
	virtualNow = epochMs
}

export const getVirtualNow = (): number => virtualNow

/**
 * Replace the global time source. Idempotent. Returns an uninstall function;
 * always call it in a `finally` so a crashed run cannot leave the process with
 * a frozen clock.
 */
export const installVirtualClock = (startEpochMs: number): (() => void) => {
	if (installed) {
		setVirtualNow(startEpochMs)
		return () => {}
	}

	virtualNow = startEpochMs
	installed = true

	// A Date subclass whose no-argument form reads the virtual clock. Every
	// other signature delegates to the real constructor unchanged.
	class VirtualDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) {
				super(virtualNow)
			} else {
				// @ts-expect-error — forwarding a variadic Date signature
				super(...args)
			}
		}

		static override now(): number {
			return virtualNow
		}
	}

	globalThis.Date = VirtualDate as unknown as DateCtor

	return () => {
		globalThis.Date = RealDate
		installed = false
	}
}

export const isVirtualClockInstalled = (): boolean => installed

/** Real wall-clock milliseconds, for measuring how long a run took. */
export const realNow = (): number => RealDate.now()

// ── IST helpers, mirroring the arithmetic the detectors use ─────────────────
// The codebase shifts by 5.5h and then reads getUTC* — these match exactly so
// the harness reasons about session boundaries the same way detectors do.

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

export const istMinutesOf = (epochMs: number): number => {
	const d = new RealDate(epochMs + IST_OFFSET_MS)
	return d.getUTCHours() * 60 + d.getUTCMinutes()
}

export const istDateStringOf = (epochMs: number): string => {
	return new RealDate(epochMs + IST_OFFSET_MS).toISOString().split('T')[0]!
}

/** Epoch ms for a given IST calendar date + minutes-since-midnight. */
export const istEpoch = (dateStr: string, istMinutes: number): number => {
	const base = RealDate.parse(`${dateStr}T00:00:00.000Z`)
	return base - IST_OFFSET_MS + istMinutes * 60 * 1000
}

export const MARKET_OPEN_MIN = 9 * 60 + 15 // 09:15 IST
export const MARKET_CLOSE_MIN = 15 * 60 + 30 // 15:30 IST

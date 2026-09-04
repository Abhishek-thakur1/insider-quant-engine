// ============================================================
// backtest/fixtures/synthetic.ts — deterministic sessions for self-testing
//
// The harness must be verifiable without a Fyers token. These generators build
// 1-minute bars with a KNOWN shape — a locked opening range, then a
// high-volume breakout — so a test can assert that real detector code fires
// through the real seam, that the virtual clock puts the replay inside the
// trading window, and that Redis TTL cooldowns expire on simulated time.
//
// Deterministic by construction (seeded PRNG), so a failing test is
// reproducible.
// ============================================================

import { istEpoch, MARKET_OPEN_MIN } from '../core/clock.js'
import type { Bar } from '../data/store.js'

/** mulberry32 — small, fast, deterministic. */
const rng = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0
	let t = seed
	t = Math.imul(t ^ (t >>> 15), t | 1)
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const SESSION_MINUTES = 375 // 09:15 → 15:29 inclusive

export interface SyntheticOptions {
	date: string
	basePrice: number
	seed?: number
	/** Baseline per-minute volume. */
	baseVolume?: number
	/** Minutes since 09:15 at which to inject a breakout, or null for none. */
	breakoutAtMinute?: number | null
	/** Multiplier applied to volume on the breakout bar. */
	breakoutVolumeMult?: number
	/** Total drift over the session, as a fraction of basePrice. */
	drift?: number
}

/**
 * A session that holds a tight range for the first 15 minutes, then — if
 * requested — breaks decisively above it on heavy volume and trends.
 */
export const syntheticSession = (opts: SyntheticOptions): Bar[] => {
	const {
		date,
		basePrice,
		seed = 42,
		baseVolume = 20_000,
		breakoutAtMinute = 20,
		breakoutVolumeMult = 6,
		drift = 0.012,
	} = opts

	const rand = rng(seed)
	const bars: Bar[] = []
	let price = basePrice

	// Opening range wide enough to clear GapAndGo's 0.5% minimum and stay under
	// its 2.5% maximum.
	const orHalf = basePrice * 0.004

	for (let m = 0; m < SESSION_MINUTES; m++) {
		const t = istEpoch(date, MARKET_OPEN_MIN + m)
		let o: number, h: number, l: number, c: number, v: number

		if (m < 15) {
			// Oscillate inside the opening range.
			const phase = Math.sin((m / 15) * Math.PI * 2)
			o = price
			c = basePrice + phase * orHalf
			h = Math.max(o, c) + orHalf * 0.15
			l = Math.min(o, c) - orHalf * 0.15
			v = baseVolume * (0.85 + rand() * 0.3)
		} else if (breakoutAtMinute !== null && m === breakoutAtMinute) {
			// The breakout bar: a decisive close well above the range high, on
			// volume big enough to clear the block-value and multiple gates.
			o = price
			c = basePrice + orHalf * 3.2
			h = c + orHalf * 0.1
			l = o - orHalf * 0.05
			v = baseVolume * breakoutVolumeMult
		} else {
			// Post-breakout drift with mild noise.
			const progress = (m - 15) / (SESSION_MINUTES - 15)
			const target = basePrice * (1 + drift * progress)
			o = price
			c = target + (rand() - 0.5) * basePrice * 0.0008
			h = Math.max(o, c) + basePrice * 0.0004
			l = Math.min(o, c) - basePrice * 0.0004
			v = baseVolume * (0.8 + rand() * 0.5)
		}

		bars.push({
			t,
			o: Number(o.toFixed(2)),
			h: Number(h.toFixed(2)),
			l: Number(l.toFixed(2)),
			c: Number(c.toFixed(2)),
			v: Math.round(v),
		})
		price = c
	}

	return bars
}

/** An index session: no volume (NSE indices report none) and a clean uptrend. */
export const syntheticIndexSession = (date: string, base = 24_000): Bar[] =>
	syntheticSession({
		date,
		basePrice: base,
		seed: 7,
		baseVolume: 0,
		breakoutAtMinute: 18,
		breakoutVolumeMult: 0,
		drift: 0.009,
	}).map((b) => ({ ...b, v: 0 }))

/** A bar pinned at a circuit band: size traded, price could not move. */
export const circuitLockedBar = (t: number, price: number, volume = 5_000): Bar => ({
	t,
	o: price,
	h: price,
	l: price,
	c: price,
	v: volume,
})

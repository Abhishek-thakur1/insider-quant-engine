// ============================================================
// tests/helpers/screenerFixtures.ts — deterministic synthetic daily markets
//
// Seeded (mulberry32), weekday calendar, bars at IST midnight like Fyers daily
// candles. A stock's daily log return = beta·benchmark + drift + noise, so the
// tests control relative strength, beta and residual alpha exactly.
// ============================================================

import type { DailyBar } from '../../src/screener/indicators.js'

export const mulberry32 = (seed: number) => () => {
	seed |= 0
	seed = (seed + 0x6d2b79f5) | 0
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Approximately normal via the sum of 6 uniforms (deterministic, no Math.random). */
const gauss = (rand: () => number) => {
	let s = 0
	for (let i = 0; i < 6; i++) s += rand()
	return (s - 3) / Math.sqrt(0.5)
}

const IST_MS = 5.5 * 3600 * 1000

/** First `n` weekdays from `start` (YYYY-MM-DD), as IST-midnight epoch ms. */
export const weekdays = (start: string, n: number): number[] => {
	const out: number[] = []
	let d = Date.parse(`${start}T00:00:00Z`)
	while (out.length < n) {
		const wd = new Date(d).getUTCDay()
		if (wd !== 0 && wd !== 6) out.push(d - IST_MS)
		d += 86_400_000
	}
	return out
}

export const dayOf = (t: number) => new Date(t + IST_MS).toISOString().slice(0, 10)

export const benchmarkReturns = (n: number, seed = 1, drift = 0.0003, sd = 0.009): number[] => {
	const rand = mulberry32(seed)
	return Array.from({ length: n }, () => drift + sd * gauss(rand))
}

export interface SeriesSpec {
	days: number[]
	bench: number[] // daily log returns, same length as days
	beta?: number
	drift?: number // daily log alpha
	noiseSd?: number
	seed?: number
	startPrice?: number
	rangePct?: number // (H − L) / C, %
	volume?: number | ((i: number) => number)
}

export const makeSeries = (s: SeriesSpec): DailyBar[] => {
	const rand = mulberry32(s.seed ?? 7)
	const beta = s.beta ?? 1
	const drift = s.drift ?? 0
	const sd = s.noiseSd ?? 0.01
	const range = (s.rangePct ?? 5) / 100
	let c = s.startPrice ?? 100
	return s.days.map((t, i) => {
		const r = i === 0 ? 0 : beta * s.bench[i]! + drift + sd * gauss(rand)
		const o = c
		c = c * Math.exp(r)
		const v = typeof s.volume === 'function' ? s.volume(i) : (s.volume ?? 2_000_000)
		return { t, o, h: Math.max(o, c) * (1 + range * 0.6), l: Math.min(o, c) * (1 - range * 0.4), c, v }
	})
}

export const benchmarkSeries = (days: number[], bench: number[]): DailyBar[] =>
	makeSeries({ days, bench, beta: 1, drift: 0, noiseSd: 0, startPrice: 20000, rangePct: 1, volume: 0 })

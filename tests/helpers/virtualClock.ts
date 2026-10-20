// ============================================================
// tests/helpers/virtualClock.ts — deterministic time for async code
//
// sleep(ms) registers a timer; run(promise) drains microtasks, then jumps the
// clock to the earliest pending timer and fires it, until the promise settles.
// No real waiting, so a 60-second retry ladder runs in milliseconds.
// ============================================================

import type { LimiterClock } from '../../src/utils/rateLimit.js'

export class VirtualClock implements LimiterClock {
	t: number
	private timers: { at: number; seq: number; fire: () => void }[] = []
	private seq = 0

	constructor(startMs = 0) {
		this.t = startMs
	}

	now = (): number => this.t

	sleep = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fire: resolve })
		})

	/** Virtual setInterval/clearInterval, for running legacy code that uses timers directly. */
	setInterval = (fn: () => void, ms: number): number => {
		const id = this.seq
		const arm = () => {
			this.timers.push({
				at: this.t + ms,
				seq: this.seq++,
				fire: () => {
					if (this.cleared.has(id)) return
					fn()
					arm()
				},
			})
		}
		arm()
		return id
	}

	clearInterval = (id: number): void => {
		this.cleared.add(id) // its pending tick fires as a no-op and is not re-armed
	}

	private cleared = new Set<number>()

	async run<T>(p: Promise<T>): Promise<T> {
		let settled = false
		const tracked = p.finally(() => {
			settled = true
		})
		for (let guard = 0; guard < 100_000; guard++) {
			for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r))
			if (settled) return tracked
			this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq)
			const next = this.timers.shift()
			if (!next) throw new Error('VirtualClock: deadlock — promise pending with no timers')
			this.t = next.at
			next.fire()
		}
		throw new Error('VirtualClock: too many steps')
	}
}

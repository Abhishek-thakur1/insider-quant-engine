// ============================================================
// utils/rateLimit.ts — sliding-window limiter + Fyers rate-limit detection
//
// The old seeder limiter refilled all tokens on a 1 s timer, so N requests
// just before a refill and N just after could start within milliseconds —
// up to 2N in any real 1 s window. Fyers counts a true rolling second and
// answered with code -360 ("Standard plan limit of 5 requests/second").
//
// This limiter guarantees at most `max` STARTS in ANY window of `windowMs`,
// FIFO. Clock and sleep are injectable so tests can run on virtual time.
// ============================================================

export interface LimiterClock {
	now: () => number
	sleep: (ms: number) => Promise<void>
}

const realClock: LimiterClock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export const createSlidingWindowLimiter = (max: number, windowMs: number, clock: LimiterClock = realClock) => {
	const starts: number[] = [] // start times inside the current window, oldest first
	let tail: Promise<void> = Promise.resolve() // serialises acquisition → FIFO

	const acquire = async (): Promise<void> => {
		for (;;) {
			const now = clock.now()
			while (starts.length > 0 && now - starts[0]! >= windowMs) starts.shift()
			if (starts.length < max) {
				starts.push(now)
				return
			}
			await clock.sleep(starts[0]! + windowMs - now)
		}
	}

	/** Run fn once a slot is free. The slot is taken when fn STARTS. */
	const limit = <T>(fn: () => Promise<T>): Promise<T> => {
		const slot = tail.then(acquire)
		tail = slot.catch(() => {})
		return slot.then(fn)
	}

	return { limit }
}

/** Fyers / Cloudflare rate-limit responses, in every shape seen in the logs. */
type ErrorLike = {
	code?: number | string
	error_code?: number
	status?: number
	cloudflare_error?: boolean
	retry_after?: number
	message?: string
	response?: { status?: number; data?: unknown }
}

export const isRateLimitError = (err: unknown): boolean => {
	if (!err || typeof err !== 'object') return false
	const error = err as ErrorLike
	if (error.code === -360 || error.code === '-360') return true // Fyers plan limit (Oct 19 log)
	if (error.error_code === 1015 || error.status === 429 || error.cloudflare_error === true) return true
	if (error.response?.status === 429) return true
	const text = `${error.message ?? ''} ${safeJson(error.response?.data)} ${safeJson(error)}`
	return /rate.?limit|plan limit|requests\/second|too many requests/i.test(text)
}

const safeJson = (v: unknown): string => {
	try {
		return JSON.stringify(v) ?? ''
	} catch {
		return ''
	}
}

/** 1 s, 2 s, 4 s … plus up to 250 ms jitter; Cloudflare's retry_after wins when present. */
export const retryDelayMs = (attempt: number, err?: unknown, rand: () => number = Math.random): number => {
	const retryAfter = (err as ErrorLike | undefined)?.retry_after
	if (typeof retryAfter === 'number') return retryAfter * 1000 + 1000
	return 1000 * 2 ** attempt + Math.floor(rand() * 250)
}

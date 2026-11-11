// ============================================================
// backtest/core/memoryRedis.ts — in-memory Redis substitute
//
// WHY NOT A REAL REDIS ON A DIFFERENT DB INDEX:
//
//   1. ISOLATION (the hard constraint). The detectors hardcode their key names
//      — `cooldown:v2:momentum:${symbol}` and friends — so the harness cannot
//      namespace them without editing detector code. Pointing at a different DB
//      index would work, but "don't run the backtest against DB 0" then becomes
//      an operational convention that one wrong env var can violate. An
//      in-memory store makes touching live state physically impossible.
//
//   2. TTL CORRECTNESS. Cooldowns are `setEx(key, 1800, …)`. Replaying a
//      session takes seconds of wall time, so real Redis TTLs would not have
//      expired by the end of the run and every detector would fire at most
//      once per backtest. This store expires against the VIRTUAL clock, so a
//      30-minute cooldown means 30 simulated minutes.
//
//   3. THROUGHPUT. ~3.3M bars x 4 synthetic ticks x several Redis calls each is
//      on the order of 10^8 operations. Over a loopback socket that is hours;
//      in-process it is minutes.
//
// HOW IT IS INJECTED — no files under src/ are modified:
// `src/config/redis.ts` exports `redisClient` as a const binding, so the
// binding itself cannot be reassigned by an importer. The VALUE is a mutable
// object, though, and all 34 importers share that one reference — so assigning
// own properties over the prototype methods swaps the implementation for
// everyone at once. That is what install() does.
//
// SUPPORTED SURFACE — exactly what src/ actually calls (verified by grep):
//   get set (incl. NX/EX/PX) setEx del lPush lTrim lRange hIncrBy hGetAll
//   hSet hGet hDel hKeys incr decr incrByFloat publish (dropped) eval (the two alert-policy scripts only)
//   multi().<cmd>…​.exec()   (chainable, incl. expire, hSet, hDel, incrByFloat)
// The hash/counter/eval/publish commands were added for the live alert pipeline and position tracker
// (backtest/bt6m, 2026-11-10); nothing that used the store before changes behaviour.
//   isOpen connect quit on
// Anything outside that list throws loudly rather than returning a plausible
// wrong answer.
// ============================================================

import { redisClient } from '../../src/config/redis.js'
import { getVirtualNow } from './clock.js'
import { COMPARE_AND_DELETE_LUA, COMPARE_AND_SET_LUA } from '../../src/workers/alertPolicy.js'

const COMPARE_AND_SET_LUA_TEXT: string = COMPARE_AND_SET_LUA
const COMPARE_AND_DELETE_LUA_TEXT: string = COMPARE_AND_DELETE_LUA

type Entry = { value: string; expiresAt: number | null }
type ListEntry = { value: string[]; expiresAt: number | null }
type HashEntry = { value: Map<string, string>; expiresAt: number | null }

export interface MemoryRedisStats {
	gets: number
	writes: number
	deletes: number
	keysLive: number
}

export class MemoryRedis {
	private strings = new Map<string, Entry>()
	private lists = new Map<string, ListEntry>()
	private hashes = new Map<string, HashEntry>()

	public stats: MemoryRedisStats = { gets: 0, writes: 0, deletes: 0, keysLive: 0 }

	// ── expiry, against the virtual clock ────────────────────────────────────
	private alive(e: { expiresAt: number | null } | undefined): boolean {
		if (!e) return false
		if (e.expiresAt === null) return true
		return getVirtualNow() < e.expiresAt
	}

	private reapString(key: string): Entry | undefined {
		const e = this.strings.get(key)
		if (e && !this.alive(e)) {
			this.strings.delete(key)
			return undefined
		}
		return e
	}

	private reapList(key: string): ListEntry | undefined {
		const e = this.lists.get(key)
		if (e && !this.alive(e)) {
			this.lists.delete(key)
			return undefined
		}
		return e
	}

	private reapHash(key: string): HashEntry | undefined {
		const e = this.hashes.get(key)
		if (e && !this.alive(e)) {
			this.hashes.delete(key)
			return undefined
		}
		return e
	}

	// ── string commands ─────────────────────────────────────────────────────
	async get(key: string): Promise<string | null> {
		this.stats.gets++
		return this.reapString(key)?.value ?? null
	}

	/** SET, with the node-redis options the live alert policy uses: { NX, EX } (and PX). */
	async set(key: string, value: string, opts?: { NX?: boolean; EX?: number; PX?: number }): Promise<'OK' | null> {
		if (opts?.NX && this.reapString(key)) return null
		this.stats.writes++
		const ttlMs = opts?.EX !== undefined ? opts.EX * 1000 : opts?.PX
		this.strings.set(key, { value: String(value), expiresAt: ttlMs !== undefined ? getVirtualNow() + ttlMs : null })
		return 'OK'
	}

	private async addNumber(key: string, by: number): Promise<number> {
		this.stats.writes++
		const e = this.reapString(key)
		const next = Number(e?.value ?? '0') + by
		this.strings.set(key, { value: String(next), expiresAt: e?.expiresAt ?? null })
		return next
	}
	async incr(key: string): Promise<number> {
		return this.addNumber(key, 1)
	}
	async decr(key: string): Promise<number> {
		return this.addNumber(key, -1)
	}
	async incrByFloat(key: string, by: number): Promise<number> {
		return this.addNumber(key, Number(by))
	}

	/** No subscribers in a backtest (the live SSE fan-out): accepted and dropped. */
	async publish(): Promise<number> {
		return 0
	}

	/**
	 * Only the two Lua scripts the live alert policy sends (src/workers/alertPolicy.ts), by exact text;
	 * any other script throws rather than returning a plausible wrong answer.
	 */
	async eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<number> {
		const key = opts.keys[0]!
		const [expected, next, ttl] = opts.arguments
		const cur = this.reapString(key)?.value ?? null
		if (script === COMPARE_AND_SET_LUA_TEXT) {
			if (cur !== expected) return 0
			await this.set(key, next!, { EX: Number(ttl) })
			return 1
		}
		if (script === COMPARE_AND_DELETE_LUA_TEXT) {
			if (cur !== expected) return 0
			return this.del(key)
		}
		throw new Error('[memoryRedis] eval: unsupported script')
	}

	async setEx(key: string, seconds: number, value: string): Promise<'OK'> {
		this.stats.writes++
		this.strings.set(key, {
			value: String(value),
			expiresAt: getVirtualNow() + seconds * 1000,
		})
		return 'OK'
	}

	async del(key: string): Promise<number> {
		this.stats.deletes++
		let n = 0
		if (this.strings.delete(key)) n++
		if (this.lists.delete(key)) n++
		if (this.hashes.delete(key)) n++
		return n
	}

	async expire(key: string, seconds: number): Promise<number> {
		const at = getVirtualNow() + seconds * 1000
		const s = this.strings.get(key)
		if (s) {
			s.expiresAt = at
			return 1
		}
		const l = this.lists.get(key)
		if (l) {
			l.expiresAt = at
			return 1
		}
		const h = this.hashes.get(key)
		if (h) {
			h.expiresAt = at
			return 1
		}
		return 0
	}

	// ── list commands ───────────────────────────────────────────────────────
	// node-redis lPush prepends, so index 0 is the newest element. The
	// detectors rely on that ordering (VolatilityContraction reads
	// history[0] as the most recent candle), so it must be preserved.
	async lPush(key: string, value: string | string[]): Promise<number> {
		this.stats.writes++
		const existing = this.reapList(key)
		const list = existing ?? { value: [] as string[], expiresAt: null }
		const items = Array.isArray(value) ? value : [value]
		for (const v of items) list.value.unshift(String(v))
		this.lists.set(key, list)
		return list.value.length
	}

	async lTrim(key: string, start: number, stop: number): Promise<'OK'> {
		const list = this.reapList(key)
		if (!list) return 'OK'
		const len = list.value.length
		const s = start < 0 ? Math.max(0, len + start) : start
		const e = stop < 0 ? len + stop : Math.min(stop, len - 1)
		list.value = e < s ? [] : list.value.slice(s, e + 1)
		return 'OK'
	}

	async lRange(key: string, start: number, stop: number): Promise<string[]> {
		this.stats.gets++
		const list = this.reapList(key)
		if (!list) return []
		const len = list.value.length
		const s = start < 0 ? Math.max(0, len + start) : start
		const e = stop < 0 ? len + stop : Math.min(stop, len - 1)
		return e < s ? [] : list.value.slice(s, e + 1)
	}

	// ── hash commands ───────────────────────────────────────────────────────
	async hIncrBy(key: string, field: string, by: number): Promise<number> {
		this.stats.writes++
		const existing = this.reapHash(key)
		const h = existing ?? { value: new Map<string, string>(), expiresAt: null }
		const next = Number(h.value.get(field) ?? '0') + by
		h.value.set(field, String(next))
		this.hashes.set(key, h)
		return next
	}

	async hGetAll(key: string): Promise<Record<string, string>> {
		this.stats.gets++
		const h = this.reapHash(key)
		if (!h) return {}
		return Object.fromEntries(h.value)
	}

	async hSet(key: string, field: string, value: string): Promise<number> {
		this.stats.writes++
		const h = this.reapHash(key) ?? { value: new Map<string, string>(), expiresAt: null }
		const isNew = !h.value.has(field)
		h.value.set(field, String(value))
		this.hashes.set(key, h)
		return isNew ? 1 : 0
	}

	async hGet(key: string, field: string): Promise<string | null> {
		this.stats.gets++
		return this.reapHash(key)?.value.get(field) ?? null
	}

	async hDel(key: string, field: string): Promise<number> {
		this.stats.deletes++
		const h = this.reapHash(key)
		return h && h.value.delete(field) ? 1 : 0
	}

	async hKeys(key: string): Promise<string[]> {
		this.stats.gets++
		return [...(this.reapHash(key)?.value.keys() ?? [])]
	}

	// ── MULTI ───────────────────────────────────────────────────────────────
	// The codebase uses `redisClient.multi().lPush(…).lTrim(…).exec()`. Real
	// Redis queues then applies atomically; here everything is synchronous and
	// single-threaded, so queueing the thunks and draining them in order on
	// exec() is equivalent.
	multi(): MultiChain {
		return new MultiChain(this)
	}

	// ── lifecycle stubs (the engine/detectors call these) ───────────────────
	get isOpen(): boolean {
		return true
	}
	async connect(): Promise<void> {}
	async quit(): Promise<void> {}
	on(): this {
		return this
	}

	// ── harness helpers ─────────────────────────────────────────────────────
	/** Wipe everything. Called between simulated sessions. */
	flushAll(): void {
		this.strings.clear()
		this.lists.clear()
		this.hashes.clear()
	}

	snapshotStats(): MemoryRedisStats {
		return {
			...this.stats,
			keysLive: this.strings.size + this.lists.size + this.hashes.size,
		}
	}

	/** Read a key without touching stats — for assertions in tests. */
	peek(key: string): string | null {
		return this.reapString(key)?.value ?? null
	}
}

class MultiChain {
	private ops: Array<() => Promise<unknown>> = []
	constructor(private store: MemoryRedis) {}

	set(k: string, v: string) {
		this.ops.push(() => this.store.set(k, v))
		return this
	}
	setEx(k: string, s: number, v: string) {
		this.ops.push(() => this.store.setEx(k, s, v))
		return this
	}
	del(k: string) {
		this.ops.push(() => this.store.del(k))
		return this
	}
	expire(k: string, s: number) {
		this.ops.push(() => this.store.expire(k, s))
		return this
	}
	lPush(k: string, v: string | string[]) {
		this.ops.push(() => this.store.lPush(k, v))
		return this
	}
	lTrim(k: string, a: number, b: number) {
		this.ops.push(() => this.store.lTrim(k, a, b))
		return this
	}
	hIncrBy(k: string, f: string, by: number) {
		this.ops.push(() => this.store.hIncrBy(k, f, by))
		return this
	}
	hSet(k: string, f: string, v: string) {
		this.ops.push(() => this.store.hSet(k, f, v))
		return this
	}
	hDel(k: string, f: string) {
		this.ops.push(() => this.store.hDel(k, f))
		return this
	}
	incrByFloat(k: string, by: number) {
		this.ops.push(() => this.store.incrByFloat(k, by))
		return this
	}

	async exec(): Promise<unknown[]> {
		const results: unknown[] = []
		for (const op of this.ops) results.push(await op())
		this.ops = []
		return results
	}
}

// ── injection ───────────────────────────────────────────────────────────────

const PATCHED_METHODS = [
	'get',
	'set',
	'setEx',
	'del',
	'expire',
	'lPush',
	'lTrim',
	'lRange',
	'hIncrBy',
	'hGetAll',
	'hSet',
	'hGet',
	'hDel',
	'hKeys',
	'incr',
	'decr',
	'incrByFloat',
	'publish',
	'eval',
	'multi',
	'connect',
	'quit',
	'on',
] as const

let active: MemoryRedis | null = null

/**
 * Swap every Redis method on the shared client for the in-memory store.
 * All importers hold the same object reference, so this is global and
 * immediate. Returns the store plus an uninstall function.
 */
export const installMemoryRedis = (): { store: MemoryRedis; uninstall: () => void } => {
	if (active) return { store: active, uninstall: () => {} }

	const store = new MemoryRedis()
	const client = redisClient as unknown as Record<string, unknown>
	const saved: Record<string, unknown> = {}
	const hadOwn = new Set<string>()

	for (const m of PATCHED_METHODS) {
		if (Object.prototype.hasOwnProperty.call(client, m)) hadOwn.add(m)
		saved[m] = client[m]
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		client[m] = (store as any)[m].bind(store)
	}

	// `isOpen` is a getter on the real client; redefine it so bootRedis() and
	// any `if (!redisClient.isOpen)` guard see an open connection.
	const isOpenDescriptor = Object.getOwnPropertyDescriptor(client, 'isOpen')
	Object.defineProperty(client, 'isOpen', { get: () => true, configurable: true })

	active = store

	const uninstall = () => {
		for (const m of PATCHED_METHODS) {
			if (hadOwn.has(m)) client[m] = saved[m]
			else delete client[m]
		}
		if (isOpenDescriptor) Object.defineProperty(client, 'isOpen', isOpenDescriptor)
		else delete client['isOpen']
		active = null
	}

	return { store, uninstall }
}

export const getMemoryRedis = (): MemoryRedis => {
	if (!active)
		throw new Error('[backtest] memory Redis is not installed — call installMemoryRedis() first')
	return active
}

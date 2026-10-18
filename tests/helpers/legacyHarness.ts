// ============================================================
// tests/helpers/legacyHarness.ts — run a worker module with its I/O faked
//
// loadWorker() takes the SOURCE TEXT of a telegramWorker.ts version, redirects
// only its I/O imports (telegraf, env, the filter, positionTracker, redis, the
// signals log) to this module, points every other relative import at the real
// file under src/, writes it to a temp .ts file and imports it. The function
// bodies run exactly as written.
//
// The fakes delegate to a PipelineDeps from workerScenarios.makeDeps(), so the
// old worker, the new worker and the bare pipeline record identical Effects for
// identical behaviour. State lives on globalThis so it's shared even if this
// module is loaded under two URLs.
// ============================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PipelineDeps, PipelineTracker } from '../../src/workers/alertPipeline.js'
import type { AlertStore } from '../../src/workers/alertPolicy.js'
import type { SignalRow } from '../../src/db/signalRecord.js'

interface HarnessState {
	deps: PipelineDeps | null
	tracker: PipelineTracker | null
	store: AlertStore | null
	signalRows: SignalRow[]
}
const g = globalThis as unknown as { __iqeHarness?: HarnessState }
export const state: HarnessState = (g.__iqeHarness ??= {
	deps: null,
	tracker: null,
	store: null,
	signalRows: [],
})

const need = <T>(v: T | null, what: string): T => {
	if (v === null) throw new Error(`legacyHarness: ${what} not set`)
	return v
}

/** Point the fakes at one scenario's deps (resolving tracker/store up front: neither records effects on creation). */
export const useDeps = async (deps: PipelineDeps): Promise<void> => {
	state.deps = deps
	state.tracker = await deps.getTracker()
	state.store = await deps.getAlertStore()
	state.signalRows = []
}

// ── fakes, named exactly as the modules they replace export them ───────────

// telegraf
export class Telegraf {
	telegram = {
		sendMessage: (chatId: string, text: string, opts?: { parse_mode?: string }) =>
			chatId === 'ADMIN'
				? need(state.deps, 'deps').sendAdmin(text)
				: need(state.deps, 'deps').sendChannel(text, !!opts?.parse_mode),
	}
	constructor(_token: string) {}
}

// config/env.js
export const ENV = {
	TELEGRAM_BOT_TOKEN: 'test-token',
	TELEGRAM_CHANNEL_ID: 'CHANNEL',
	get TELEGRAM_ADMIN_ID() {
		return need(state.deps, 'deps').config.hasAdmin ? 'ADMIN' : ''
	},
	get PAPER_CAPITAL_BASE() {
		return need(state.deps, 'deps').config.capitalBase
	},
	get CAPITAL_CONSTRAINT_BEHAVIOR() {
		return need(state.deps, 'deps').config.capitalBehavior
	},
}

// detectors/janeStreetFilter.js
export const CONFIRMATION_THRESHOLD = 78
export const runJaneStreetFilter = (data: Parameters<PipelineDeps['runFilter']>[0]) =>
	need(state.deps, 'deps').runFilter(data)

// core/positionTracker.js
export const positionTracker: PipelineTracker = {
	getCurrentNotional: () => need(state.tracker, 'tracker').getCurrentNotional(),
	registerTrade: (pos) => need(state.tracker, 'tracker').registerTrade(pos),
}

// config/redis.js
export const redisClient: AlertStore = {
	set: (k, v, o) => need(state.store, 'store').set(k, v, o),
	incr: (k) => need(state.store, 'store').incr(k),
	decr: (k) => need(state.store, 'store').decr(k),
	expire: (k, s) => need(state.store, 'store').expire(k, s),
	del: (k) => need(state.store, 'store').del(k),
}

// db/signalLog.js
export const signalLog = {
	enqueue: (row: SignalRow) => {
		state.signalRows.push(row)
	},
}

// ── loader ──────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const WORKERS_DIR = path.join(REPO, 'src', 'workers')
const SELF_URL = pathToFileURL(path.join(HERE, 'legacyHarness.ts')).href

// Specifiers (as written in telegramWorker.ts) that are I/O and get faked.
const FAKED = new Set([
	'telegraf',
	'../config/env.js',
	'../detectors/janeStreetFilter.js',
	'../core/positionTracker.js',
	'../config/redis.js',
	'../db/signalLog.js',
])

const resolveSpecifier = (spec: string): string => {
	if (FAKED.has(spec)) return SELF_URL
	if (spec.startsWith('.'))
		return pathToFileURL(path.resolve(WORKERS_DIR, spec).replace(/\.js$/, '.ts')).href
	if (spec.startsWith('node:')) return spec
	throw new Error(
		`legacyHarness: unexpected bare import "${spec}" — fake it or allow it explicitly`,
	)
}

/** Rewrite import specifiers only. Returns the new source and the specifiers that were faked. */
export const rewriteImports = (source: string): { code: string; faked: string[] } => {
	const faked: string[] = []
	const code = source
		.split('\n')
		.map((line) => {
			if (line.trim().startsWith('//')) return line // archived blocks stay inert
			return line
				.replace(/(from\s+)'([^']+)'/g, (_m, pre: string, spec: string) => {
					if (FAKED.has(spec)) faked.push(spec)
					return `${pre}'${resolveSpecifier(spec)}'`
				})
				.replace(/import\('([^']+)'\)/g, (_m, spec: string) => {
					if (FAKED.has(spec)) faked.push(spec)
					return `import('${resolveSpecifier(spec)}')`
				})
		})
		.join('\n')
	return { code, faked }
}

type WorkerModule = { sendTelegramAlert: (data: unknown) => Promise<void> }
const cache = new Map<string, WorkerModule>()

/**
 * Import a worker version with SHADOW_MODE fixed (it's read at module load).
 * `label` keeps the old and new versions in separate temp files.
 */
export const loadWorker = async (
	label: string,
	source: string,
	shadowMode: boolean,
): Promise<WorkerModule> => {
	const key = `${label}-${shadowMode ? 'shadow' : 'live'}`
	const hit = cache.get(key)
	if (hit) return hit
	const { code } = rewriteImports(source.replace(/\r\n/g, '\n'))
	const file = path.join(os.tmpdir(), `iqe-worker-${key}-${process.pid}.ts`)
	fs.writeFileSync(file, code)
	const saved = {
		SHADOW_MODE: process.env.SHADOW_MODE,
		TELEGRAM_MAX_ALERTS_PER_DAY: process.env.TELEGRAM_MAX_ALERTS_PER_DAY,
		BACKTEST_MODE: process.env.BACKTEST_MODE,
	}
	process.env.SHADOW_MODE = shadowMode ? 'true' : 'false'
	process.env.TELEGRAM_MAX_ALERTS_PER_DAY = '20'
	delete process.env.BACKTEST_MODE
	try {
		const mod = (await import(pathToFileURL(file).href)) as WorkerModule
		cache.set(key, mod)
		return mod
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
	}
}

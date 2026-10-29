import crypto from 'node:crypto'
import { Telegraf } from 'telegraf'
import { ENV } from '../config/env.js'
import { runJaneStreetFilter, CONFIRMATION_THRESHOLD } from '../detectors/janeStreetFilter.js'
import type { DetectorType } from '../utils/regimeDetector.js'
import { COMPARE_AND_DELETE_LUA, COMPARE_AND_SET_LUA, parseMaxAlertsPerDay } from './alertPolicy.js'
import { runAlertPipeline, type PipelineDeps } from './alertPipeline.js'
import { newSignalDraft, buildSignalRow, type SignalDraft } from '../db/signalRecord.js'
import { signalLog } from '../db/signalLog.js'
import { getSymbolSource } from '../core/symbolSource.js'
import { getEvShadow } from '../core/evShadow.js'

const bot = new Telegraf(ENV.TELEGRAM_BOT_TOKEN)
const SHADOW_MODE = process.env.SHADOW_MODE === 'true'
const MAX_ALERTS_PER_DAY = parseMaxAlertsPerDay(process.env.TELEGRAM_MAX_ALERTS_PER_DAY)

export interface AlertPayload {
	symbol: string
	price: number
	side: 'LONG' | 'SHORT'
	percentageChange: number
	volumeSpikeRatio: number
	trigger: string
	vwap: number
	avgPrice: number
	// Optional: pass detector name for precise regime classification.
	// Existing detectors don't need to add this — trigger text is used
	// as a classification fallback when absent.
	detectorName?: string
	// [FIX — root cause #2] Explicit regime class. Every ACTIVE detector sets
	// this. It takes precedence over detectorName and over trigger-text keyword
	// matching, so a detector's edge source is declared rather than inferred
	// from its alert copy. Archived/legacy detectors may omit it and fall back.
	regimeClass?: DetectorType
	durationClass?: 'INTRADAY' | 'SWING'
}

// ── BACKTEST SEAM (additive; inert unless explicitly enabled) ───────────────
// The backtest harness must capture what a detector WOULD have alerted without
// dispatching to Telegram, and it needs the raw (ungated) signal so it can
// report gated vs ungated fire rates. Detectors import `sendTelegramAlert`
// directly and ESM const bindings cannot be reassigned by an importer, so the
// interception point has to live here.
//
// Two independent conditions must both hold to divert a signal: BACKTEST_MODE
// must be set in the environment AND a collector must have been installed at
// runtime. In normal operation neither is true and the only added cost is one
// boolean check per alert.
export const backtestSink: { collect: ((payload: AlertPayload) => void) | null } = {
	collect: null,
}
const BACKTEST_MODE = process.env.BACKTEST_MODE === 'true'

// Live I/O for the pipeline (alertPipeline.ts holds the logic, env-free and tested).
const loadRedis = async () => (await import('../config/redis.js')).redisClient
const liveDeps: PipelineDeps = {
	runFilter: (data) => runJaneStreetFilter(data, data.detectorName),
	getTracker: async () => (await import('../core/positionTracker.js')).positionTracker,
	getAlertStore: loadRedis,
	getClaimStore: async () => {
		const redisClient = await loadRedis()
		return {
			get: (k) => redisClient.get(k),
			set: (k, v, o) => redisClient.set(k, v, o),
			compareAndSet: async (k, expected, next, ttl) =>
				Number(await redisClient.eval(COMPARE_AND_SET_LUA, { keys: [k], arguments: [expected, next, String(ttl)] })) === 1,
			compareAndDelete: async (k, expected) =>
				Number(await redisClient.eval(COMPARE_AND_DELETE_LUA, { keys: [k], arguments: [expected] })) === 1,
		}
	},
	sendChannel: (text, markdown) =>
		markdown
			? bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, text, { parse_mode: 'Markdown' })
			: bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, text),
	sendAdmin: (text) => bot.telegram.sendMessage(ENV.TELEGRAM_ADMIN_ID, text),
	// No-op unless the engine created the EV-reject shadow tracker (EV_SHADOW_ENABLED=true).
	onEvRejected: (data, decision, signalId) => getEvShadow()?.record(data, decision, signalId),
	now: () => Date.now(),
	// SHADOW_MODE / MAX_ALERTS_PER_DAY were module-level constants in the old
	// worker; ENV.* was read on every call. Getters keep exactly that timing
	// (caught by tests/legacyWorkerParity.test.ts).
	config: {
		shadowMode: SHADOW_MODE,
		maxAlertsPerDay: MAX_ALERTS_PER_DAY,
		get capitalBase() {
			return ENV.PAPER_CAPITAL_BASE
		},
		get capitalBehavior() {
			return ENV.CAPITAL_CONSTRAINT_BEHAVIOR
		},
		get hasAdmin() {
			return !!ENV.TELEGRAM_ADMIN_ID
		},
	},
}

export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
	if (BACKTEST_MODE && backtestSink.collect) {
		// Capture and stop. No filter call (the harness invokes the gating chain
		// itself, so it can score gated and ungated separately) and no dispatch.
		backtestSink.collect(data)
		return
	}

	// Signals log (observation only): one row per fire, written asynchronously.
	// Any failure here is swallowed — it must never stop a trade or an alert.
	let draft: SignalDraft | null = null
	try {
		draft = newSignalDraft(data, { signalId: crypto.randomUUID(), firedAt: Date.now(), shadowMode: SHADOW_MODE })
	} catch {
		draft = null
	}

	try {
		await runAlertPipeline(data, liveDeps, draft)
	} finally {
		if (draft) {
			try {
				signalLog.enqueue(
					buildSignalRow(draft, { threshold: CONFIRMATION_THRESHOLD, promotionSource: getSymbolSource(data.symbol) }),
				)
			} catch (err) {
				console.error('[SignalLog] ❌ Could not build signal row (trade/alert unaffected):', err)
			}
		}
	}
}
// import { Telegraf } from 'telegraf'
// import { ENV } from '../config/env.js'

// const bot = new Telegraf(ENV.TELEGRAM_BOT_TOKEN)

// export interface AlertPayload {
// 	symbol: string
// 	price: number
// 	side: 'LONG' | 'SHORT'
// 	percentageChange: number
// 	volumeSpikeRatio: number
// 	trigger: string
// 	vwap: number
// 	avgPrice: number
// 	detectorName?: string
// }

// export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
// 	try {
// 		const isLong = data.side === 'LONG'
// 		const isOptions = data.symbol.includes('CE') || data.symbol.includes('PE')

// 		let message = ''

// 		if (isOptions) {
// 			// ── OPTIONS TEMPLATE ──────────────────────────────────────
// 			// Options detectors pass specific premium, SL, and targets inside the trigger string.
// 			// We format it to look incredibly clean and authoritative.

// 			const directionEmoji = isLong ? '📈' : '📉'

// 			message = `
// 🚨 *NIFTY SNIPER SETUP* 🚨

// ${directionEmoji} *Action:* BUY ${data.symbol}
// 📊 *Index Level:* ₹${data.price}

// *⚡ The Edge:*
// • ${data.trigger.replace(/\|/g, '\n• ')}

// ⏳ *Horizon:* Intraday Scalp
// ⚠️ _Options decay fast. Stick to the Stop Loss._
//             `.trim()
// 		} else {
// 			// ── EQUITY CASH TEMPLATE ──────────────────────────────────
// 			// For standard stocks, we calculate the exact RR levels natively.

// 			const entry = data.price

// 			// SL: 0.2% behind VWAP protection
// 			const stopLoss = isLong
// 				? Number((data.vwap * 0.998).toFixed(2))
// 				: Number((data.vwap * 1.002).toFixed(2))

// 			const risk = Math.abs(entry - stopLoss)

// 			const target1 = isLong
// 				? Number((entry + risk * 1.5).toFixed(2))
// 				: Number((entry - risk * 1.5).toFixed(2))

// 			const target2 = isLong
// 				? Number((entry + risk * 2.5).toFixed(2))
// 				: Number((entry - risk * 2.5).toFixed(2))

// 			const actionLabel = isLong ? '🟢 BUY LONG' : '🔴 SELL SHORT'
// 			const volumeStr =
// 				data.volumeSpikeRatio > 1.2
// 					? `\n• Volume: ${data.volumeSpikeRatio}x Institutional Surge 🔥`
// 					: ''

// 			message = `
// ⚡ *NEW TRADE ALERT* ⚡

// ${actionLabel}
// 📌 *Asset:* ${data.symbol}

// *📊 The Edge:*
// • Strategy: ${data.trigger}${volumeStr}

// *🎯 Execution Plan:*
// • *Entry:* ₹${entry}
// • *Target 1:* ₹${target1}
// • *Target 2:* ₹${target2}
// • *Stop Loss:* ₹${stopLoss}

// ⏳ *Horizon:* Intraday Only
// ⚖️ _Capital preservation first. Respect the levels._
//             `.trim()
// 		}

// 		// Send to Telegram using legacy Markdown parsing
// 		await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message, {
// 			parse_mode: 'Markdown',
// 		})

// 		console.log(`✅ [${data.side}] Public Alert dispatched for ${data.symbol}`)
// 	} catch (error) {
// 		console.error(`❌ Failed to send Telegram alert:`, error)
// 	}
// }

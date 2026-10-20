import { Telegraf } from 'telegraf'
import { ENV } from '../config/env.js'
import { runJaneStreetFilter } from '../detectors/janeStreetFilter.js'
import type { DetectorType } from '../utils/regimeDetector.js'
import {
	buildEquityMessage,
	computeSizing,
	dispatchBlockReason,
	getISTDateString,
	parseMaxAlertsPerDay,
	releaseAlertSlot,
	reserveAlertSlot,
} from './alertPolicy.js'

const bot = new Telegraf(ENV.TELEGRAM_BOT_TOKEN)
const SHADOW_MODE = process.env.SHADOW_MODE === 'true'
const MAX_ALERTS_PER_DAY = parseMaxAlertsPerDay(process.env.TELEGRAM_MAX_ALERTS_PER_DAY)

// Gates that represent a structural/mathematical disqualification of the
// signal (wrong regime, negative EV, failed Bayesian confidence, Kelly sizing
// says don't take it) — these must NEVER dispatch, even in shadow mode.
// Shadow mode is only meant to relax the aggregate SCORE threshold so we can
// calibrate where that cutoff should sit; it is not a bypass for gates that
// mean the trade is mathematically unsound.
//
// IMPORTANT: confirm these strings exactly match the values janeStreetFilter.ts
// assigns to `decision.rejectedAt` before relying on this list.
const HARD_GATES = new Set(['REGIME', 'BAYESIAN', 'EV', 'KELLY'])

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

export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
	if (BACKTEST_MODE && backtestSink.collect) {
		// Capture and stop. No filter call (the harness invokes the gating chain
		// itself, so it can score gated and ungated separately) and no dispatch.
		backtestSink.collect(data)
		return
	}

	// ── CONFIRMATION ENGINE GATE ─────────────────────────────────────────────
	let decision: Awaited<ReturnType<typeof runJaneStreetFilter>> | null = null

	try {
		decision = await runJaneStreetFilter(data, data.detectorName)

		const isHardGateRejection = !!decision.rejectedAt && HARD_GATES.has(decision.rejectedAt)

		// Not recorded: outright failed outside shadow mode, OR failed on a hard
		// gate regardless of shadow mode. (Pre-existing behaviour, unchanged here;
		// the planned `signals` table will log these too.)
		if (!decision.passed && (isHardGateRejection || !SHADOW_MODE)) {
			console.log(
				`🚫 [${data.side}] ${data.symbol} blocked — score ${decision.score}/100 (${decision.rejectedAt ?? 'below threshold'})${
					isHardGateRejection && SHADOW_MODE ? ' [hard gate — shadow mode does not override]' : ''
				}`,
			)
			return
		}
	} catch (filterErr) {
		// Fail open for RECORDING: a bug in the confirmation layer must never
		// silently drop the signal from the data set. It is recorded as ungated
		// and is NOT sent to the channel (alert policy: gated-only).
		console.error('[Confirmation Engine] ⚠️ Error — recording signal as ungated, not alerting:', filterErr)
	}
	// ── END CONFIRMATION GATE ──────────────────────────────────────────────

	try {
		const isLong = data.side === 'LONG'
		const isOptions = data.symbol.endsWith('CE') || data.symbol.endsWith('PE')
		const entry = data.price
		const durationClass = data.durationClass || 'INTRADAY'

		// Levels — computed ONCE; the same numbers are tracked in Postgres and
		// shown in the message.
		let stopLoss: number
		let target1: number
		let target2: number

		if (!isOptions) {
			stopLoss = isLong
				? Number((data.vwap * 0.998).toFixed(2))
				: Number((data.vwap * 1.002).toFixed(2))
			const risk = Math.abs(entry - stopLoss)
			target1 = isLong ? Number((entry + risk * 1.5).toFixed(2)) : Number((entry - risk * 1.5).toFixed(2))
			target2 = isLong ? Number((entry + risk * 2.5).toFixed(2)) : Number((entry - risk * 2.5).toFixed(2))
		} else {
			// Option alerts embed index-level SL/T1 in the trigger text.
			const slMatch = data.trigger.match(/SL ₹(\d+(\.\d+)?)/)
			const t1Match = data.trigger.match(/T1 ₹(\d+(\.\d+)?)/)
			stopLoss = slMatch ? Number(slMatch[1]) : isLong ? entry * 0.9 : entry * 1.1
			target1 = t1Match ? Number(t1Match[1]) : isLong ? entry * 1.2 : entry * 0.8
			target2 = target1
		}

		// Capital-constrained position sizing
		const { positionTracker } = await import('../core/positionTracker.js')
		const sizing = computeSizing({
			entry,
			stopLoss,
			capitalBase: ENV.PAPER_CAPITAL_BASE,
			currentNotional: positionTracker.getCurrentNotional(),
			behavior: ENV.CAPITAL_CONSTRAINT_BEHAVIOR,
		})
		if (sizing.capitalGated) {
			console.warn(
				`[PositionSizing] ${data.symbol}: capital-gated — qty ${sizing.qty} → ${sizing.actualSize}${sizing.skip ? ' (skipped)' : ' (reduced)'}`,
			)
		}

		const gated = decision?.passed ?? false

		// Record EVERY trade that reaches this point, before any alert decision.
		await positionTracker.registerTrade({
			id: `trade_${Date.now()}_${data.symbol}`,
			symbol: data.symbol,
			side: data.side,
			entryPrice: entry,
			stopLoss,
			target: target1, // We track Target 1 for the PnL hit
			timestamp: Date.now(),
			detectorName: data.detectorName || 'UNKNOWN',
			size: sizing.qty, // Full unconstrained size for historical significance testing
			regimeClass: data.regimeClass || decision?.regime || 'UNIVERSAL',
			gated,
			capitalGated: sizing.capitalGated,
			actualSize: sizing.actualSize,
			durationClass,
		})

		// ── ALERT POLICY (Telegram only — never affects what is recorded) ──────
		const block = dispatchBlockReason({
			gated,
			skip: sizing.skip,
			actualSize: sizing.actualSize,
			isOption: isOptions,
		})
		if (block) {
			console.log(`🔕 [${data.side}] ${data.symbol} recorded, not alerted (${block})`)
			return
		}

		const { redisClient } = await import('../config/redis.js')
		const slotArgs = {
			day: getISTDateString(),
			detector: data.detectorName || 'UNKNOWN',
			symbol: data.symbol,
		}
		const slot = await reserveAlertSlot(redisClient, { ...slotArgs, maxPerDay: MAX_ALERTS_PER_DAY })
		if (slot.action === 'DUPLICATE') {
			console.log(`🔕 [${data.side}] ${data.symbol} recorded, not alerted (already alerted today for ${slotArgs.detector})`)
			return
		}
		if (slot.action === 'CAP_REACHED') {
			console.log(`🔕 [${data.side}] ${data.symbol} recorded, not alerted (daily cap ${MAX_ALERTS_PER_DAY} reached)`)
			if (slot.notifyCap && ENV.TELEGRAM_ADMIN_ID) {
				bot.telegram
					.sendMessage(
						ENV.TELEGRAM_ADMIN_ID,
						`ℹ️ Daily alert cap (${MAX_ALERTS_PER_DAY}) reached. Further signals today are recorded but not sent.`,
					)
					.catch((e) => console.error('[TelegramWorker] cap notice failed:', e))
			}
			return
		}

		const scoreLines = decision
			? `\n\n🧮 *Confirmation Score: ${decision.score}/100*\n• Regime: ${decision.regime} (H=${decision.entropy.toFixed(2)})\n• Bayesian P(win): ${(decision.posterior * 100).toFixed(0)}%\n• EV: ₹${decision.ev.toFixed(0)}`
			: ''

		let message: string
		if (isOptions) {
			const directionEmoji = isLong ? '📈' : '📉'
			message = `
🚨 *NIFTY SNIPER SETUP* 🚨

${directionEmoji} *Action:* BUY ${data.symbol}
📊 *Index Level:* ₹${data.price}

*⚡ The Edge:*
• ${data.trigger.replace(/\|/g, '\n• ')}${scoreLines}

⏳ *Horizon:* Intraday Scalp
⚠️ _Options decay fast. Stick to the Stop Loss._
            `.trim()
		} else {
			message = buildEquityMessage({
				symbol: data.symbol,
				side: data.side,
				trigger: data.trigger,
				volumeSpikeRatio: data.volumeSpikeRatio,
				entry,
				stopLoss,
				target1,
				target2,
				qty: sizing.actualSize,
				durationClass,
				scoreLines,
			})
		}

		try {
			await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message, { parse_mode: 'Markdown' })
		} catch (mdErr) {
			// Unescaped Markdown (e.g. `_` in a symbol) makes Telegram reject the
			// message. Retry as plain text rather than lose the alert.
			console.warn('[TelegramWorker] Markdown send failed, retrying as plain text:', mdErr)
			try {
				await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message.replace(/[*_`]/g, ''))
			} catch (plainErr) {
				await releaseAlertSlot(redisClient, slotArgs).catch(() => {})
				throw plainErr
			}
		}

		console.log(
			`✅ [${data.side}] Alert dispatched for ${data.symbol}${decision ? ` (score ${decision.score}/100)` : ''}`,
		)
	} catch (error) {
		console.error(`❌ Failed to send Telegram alert:`, error)
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

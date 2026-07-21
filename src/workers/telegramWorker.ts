import { Telegraf } from 'telegraf'
import { ENV } from '../config/env.js'
import { runJaneStreetFilter } from '../detectors/janeStreetFilter.js'

const bot = new Telegraf(ENV.TELEGRAM_BOT_TOKEN)
const SHADOW_MODE = process.env.SHADOW_MODE === 'true'

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
}

export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
	// ── CONFIRMATION ENGINE GATE ─────────────────────────────────────────────
	let decision: Awaited<ReturnType<typeof runJaneStreetFilter>> | null = null

	try {
		decision = await runJaneStreetFilter(data, data.detectorName)

		const isHardGateRejection = !!decision.rejectedAt && HARD_GATES.has(decision.rejectedAt)

		// Block if: outright failed and not in shadow mode, OR failed on a hard
		// gate regardless of shadow mode. Shadow mode only lets pure "score came
		// in under the aggregate threshold" rejections through for calibration.
		if (!decision.passed && (isHardGateRejection || !SHADOW_MODE)) {
			// Signal blocked. Decision already logged to Redis.
			console.log(
				`🚫 [${data.side}] ${data.symbol} blocked — score ${decision.score}/100 (${decision.rejectedAt ?? 'below threshold'})${
					isHardGateRejection && SHADOW_MODE ? ' [hard gate — shadow mode does not override]' : ''
				}`,
			)
			return
		}

		if (!decision.passed && SHADOW_MODE) {
			console.log(
				`👁️ [SHADOW] [${data.side}] ${data.symbol} would have been BLOCKED — score ${decision.score}/100 — firing anyway (shadow mode, threshold-only rejection)`,
			)
		}
	} catch (filterErr) {
		// If the engine itself throws (Redis down, etc.), fail OPEN so a bug
		// in the confirmation layer never silently kills your whole alert
		// pipeline. Log loudly — this should be rare and worth investigating.
		console.error('[Confirmation Engine] ⚠️ Error — passing signal through unfiltered:', filterErr)
	}
	// ── END CONFIRMATION GATE ──────────────────────────────────────────────

	try {
		const isLong = data.side === 'LONG'
		const isOptions = data.symbol.includes('CE') || data.symbol.includes('PE')

		const scoreNote = decision
			? `\n\n🧮 *Confirmation Score: ${decision.score}/100*${decision.shadowMode && !decision.passed ? ' ⚠️ SHADOW — below threshold' : ''}\n• Regime: ${decision.regime} (H=${decision.entropy.toFixed(2)})\n• Bayesian P(win): ${(decision.posterior * 100).toFixed(0)}%\n• EV: ₹${decision.ev.toFixed(0)} | Half-Kelly: ${(decision.kellyHalf * 100).toFixed(1)}%\n• ${decision.positionNote}`
			: ''

		let message = ''

		if (isOptions) {
			const directionEmoji = isLong ? '📈' : '📉'

			message = `
🚨 *NIFTY SNIPER SETUP* 🚨

${directionEmoji} *Action:* BUY ${data.symbol}
📊 *Index Level:* ₹${data.price}

*⚡ The Edge:*
• ${data.trigger.replace(/\|/g, '\n• ')}${scoreNote}

⏳ *Horizon:* Intraday Scalp
⚠️ _Options decay fast. Stick to the Stop Loss._
            `.trim()
		} else {
			const entry = data.price

			const stopLoss = isLong
				? Number((data.vwap * 0.998).toFixed(2))
				: Number((data.vwap * 1.002).toFixed(2))

			const risk = Math.abs(entry - stopLoss)

			const target1 = isLong
				? Number((entry + risk * 1.5).toFixed(2))
				: Number((entry - risk * 1.5).toFixed(2))

			const target2 = isLong
				? Number((entry + risk * 2.5).toFixed(2))
				: Number((entry - risk * 2.5).toFixed(2))

			const actionLabel = isLong ? '🟢 BUY LONG' : '🔴 SELL SHORT'
			const volumeStr =
				data.volumeSpikeRatio > 1.2
					? `\n• Volume: ${data.volumeSpikeRatio}x Institutional Surge 🔥`
					: ''

			message = `
⚡ *NEW TRADE ALERT* ⚡

${actionLabel}
📌 *Asset:* ${data.symbol}

*📊 The Edge:*
• Strategy: ${data.trigger}${volumeStr}

*🎯 Execution Plan:*
• *Entry:* ₹${entry}
• *Target 1:* ₹${target1}
• *Target 2:* ₹${target2}
• *Stop Loss:* ₹${stopLoss}${scoreNote}

⏳ *Horizon:* Intraday Only
⚖️ _Capital preservation first. Respect the levels._
            `.trim()
		}

		await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message, {
			parse_mode: 'Markdown',
		})

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

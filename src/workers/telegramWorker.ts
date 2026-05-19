// ============================================================
// telegramWorker.ts — Telegram Alert Dispatcher
//
// JANE STREET FILTER INTEGRATION:
// The JS filter is injected HERE as an interceptor.
// No detector files needed any changes.
//
// Flow:
//   Detector fires sendTelegramAlert(payload) →
//   JS filter runs 4 gates (regime, bayes, EV, kelly) →
//   PASS: alert fires with position sizing note appended →
//   FAIL: alert blocked, rejection logged to Redis
//
// CHANGED VS ORIGINAL:
//   1. AlertPayload gets optional `detectorName?: string`
//   2. sendTelegramAlert awaits runJaneStreetFilter() first
//   3. If filter rejects → return early (no Telegram message)
//   4. If filter passes → append JS position note to message
// ============================================================

import { Telegraf } from 'telegraf'
import { ENV } from '../config/env.js'
import { runJaneStreetFilter } from '../detectors/janeStreetFilter.js'

const bot = new Telegraf(ENV.TELEGRAM_BOT_TOKEN)

export interface AlertPayload {
	symbol: string
	price: number
	side: 'LONG' | 'SHORT'
	percentageChange: number
	volumeSpikeRatio: number
	trigger: string
	vwap: number
	avgPrice: number
	// [NEW] Optional: pass detector name for precise regime classification.
	// Existing detectors can add this gradually. If absent, trigger text is used.
	detectorName?: string
	sl: number
    t1: number
}

export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
	// ── JANE STREET FILTER GATE ──────────────────────────────────────────────
	// This is the only code change needed in the entire codebase.
	// All 4 gates run here. If any fails → return without sending.
	let filterDecision: Awaited<ReturnType<typeof runJaneStreetFilter>> | null = null

	try {
		filterDecision = await runJaneStreetFilter(data, data.detectorName)

		if (!filterDecision.passed) {
			// Signal blocked. Decision already logged to Redis by the filter.
			// Nothing goes to Telegram.
			return
		}
	} catch (filterErr) {
		// If the filter itself throws (Redis down, etc.), fail OPEN to preserve
		// existing behavior. Log the error but don't block the alert.
		console.error('[JS Filter] ⚠️ Filter error — passing signal through:', filterErr)
	}
	// ── END FILTER GATE ───────────────────────────────────────────────────────

	try {
		const isLong = data.side === 'LONG'
		const isOptions = data.symbol.includes('CE') || data.symbol.includes('PE')

		// Build the JS edge note to append to every approved alert
		const jsNote = filterDecision
			? `\n\n🧮 *Jane Street Gate:*\n• ${filterDecision.positionNote}\n• Regime: ${filterDecision.regime} (H=${filterDecision.entropy.toFixed(2)})\n• Bayesian P(win): ${(filterDecision.posterior * 100).toFixed(0)}%\n• EV: ₹${filterDecision.ev.toFixed(0)} | Kelly size: ${(filterDecision.kellyHalf * 100).toFixed(1)}% of capital`
			: ''

		let message = ''

		if (isOptions) {
			// ── OPTIONS TEMPLATE ──────────────────────────────────────────
			const directionEmoji = isLong ? '📈' : '📉'

			message = `
🚨 *NIFTY SNIPER SETUP* 🚨

${directionEmoji} *Action:* BUY ${data.symbol}
📊 *Index Level:* ₹${data.price}

*⚡ The Edge:*
• ${data.trigger.replace(/\|/g, '\n• ')}${jsNote}

⏳ *Horizon:* Intraday Scalp
⚠️ _Options decay fast. Stick to the Stop Loss._
            `.trim()
		} else {
			// ── EQUITY CASH TEMPLATE ──────────────────────────────────────
			const entry = data.price

			// SL: 0.2% behind VWAP protection
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
• *Stop Loss:* ₹${stopLoss}${jsNote}

⏳ *Horizon:* Intraday Only
⚖️ _Capital preservation first. Respect the levels._
            `.trim()
		}

		// Send to Telegram using legacy Markdown parsing
		await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message, {
			parse_mode: 'Markdown',
		})

		console.log(`✅ [${data.side}] Public Alert dispatched for ${data.symbol}`)
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

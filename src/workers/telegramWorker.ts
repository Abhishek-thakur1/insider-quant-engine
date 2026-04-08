import { Telegraf } from 'telegraf'
import { ENV } from '../config/env.js'

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
}

export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
	try {
		const isLong = data.side === 'LONG'
		const isOptions = data.symbol.includes('CE') || data.symbol.includes('PE')

		let message = ''

		if (isOptions) {
			// ── OPTIONS TEMPLATE ──────────────────────────────────────
			// Options detectors pass specific premium, SL, and targets inside the trigger string.
			// We format it to look incredibly clean and authoritative.

			const directionEmoji = isLong ? '📈' : '📉'

			message = `
🚨 *NIFTY SNIPER SETUP* 🚨

${directionEmoji} *Action:* BUY ${data.symbol}
📊 *Index Level:* ₹${data.price}

*⚡ The Edge:*
• ${data.trigger.replace(/\|/g, '\n• ')}

⏳ *Horizon:* Intraday Scalp
⚠️ _Options decay fast. Stick to the Stop Loss._
            `.trim()
		} else {
			// ── EQUITY CASH TEMPLATE ──────────────────────────────────
			// For standard stocks, we calculate the exact RR levels natively.

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
• *Stop Loss:* ₹${stopLoss}

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

// import { Telegraf } from 'telegraf';
// import { ENV } from '../config/env.js';

// const bot = new Telegraf(ENV.TELEGRAM_BOT_TOKEN);

// export interface AlertPayload {
//     symbol: string;
//     price: number;
//     side: 'LONG' | 'SHORT';
//     percentageChange: number;
//     volumeSpikeRatio: number;
//     trigger: string;
//     vwap: number;
//     avgPrice: number;
// }

// export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
//     try {
//         const isLong = data.side === 'LONG';
//         const entry = data.price;

//         // ── Stop Loss ──────────────────────────────────────────
//         // Long  → SL below VWAP (institutions defend VWAP on longs)
//         // Short → SL above VWAP (institutions defend VWAP on shorts)
//         const stopLoss = isLong
//             ? Number((data.vwap * 0.998).toFixed(2))   // 0.2% below VWAP
//             : Number((data.vwap * 1.002).toFixed(2));  // 0.2% above VWAP

//         const risk = Math.abs(entry - stopLoss);

//         // ── Targets ────────────────────────────────────────────
//         // Long  → targets above entry
//         // Short → targets below entry
//         const target1 = isLong
//             ? Number((entry + risk * 1.5).toFixed(2))
//             : Number((entry - risk * 1.5).toFixed(2));

//         const target2 = isLong
//             ? Number((entry + risk * 2.5).toFixed(2))
//             : Number((entry - risk * 2.5).toFixed(2));

//         const sideEmoji = isLong ? '🟢' : '🔴';
//         const sideLabel = isLong ? 'LONG' : 'SHORT';
//         const entryLabel = isLong ? 'Buy above' : 'Sell below';
//         const slLabel = isLong ? 'Below VWAP' : 'Above VWAP';

//         const message = `
// ${sideEmoji} *INSTITUTIONAL ${sideLabel} SIGNAL*

// 📌 *${data.symbol}*
// 💵 *CMP:* ₹${data.price} (${data.percentageChange > 0 ? '+' : ''}${data.percentageChange}%)
// 📊 *Volume:* ${data.volumeSpikeRatio}× institutional surge
// ⚙️ *Signal:* ${data.trigger}

// ─────────────────────
// 🎯 *TRADE SETUP*
// 📥 *Entry:* ₹${entry} (${entryLabel})
// 🛑 *Stop Loss:* ₹${stopLoss} (${slLabel})
// 🎯 *Target 1:* ₹${target1} (1:1.5 RR)
// 🎯 *Target 2:* ₹${target2} (1:2.5 RR)
// 📐 *VWAP:* ₹${data.vwap.toFixed(2)}
// ─────────────────────
// ⚠️ _Verify on chart before entry. Intraday only — exit by 3:15 PM._
//         `;

//         await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message, {
//             parse_mode: 'Markdown',
//         });

//         console.log(`✅ [${sideLabel}] Alert dispatched for ${data.symbol}`);
//     } catch (error) {
//         console.error(`❌ Failed to send Telegram alert:`, error);
//     }
// };

// export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
//     try {
//         const message = `
// 🚨 *QUANT ANOMALY DETECTED* 🚨

// 📈 *Stock:* ${data.symbol}
// 💵 *CMP:* ₹${data.price} (${data.percentageChange > 0 ? '+' : ''}${data.percentageChange}%)
// 🔥 *Volume:* ${data.volumeSpikeRatio * 100}% above average
// ⚙️ *Trigger:* ${data.trigger}

// _System: Fastify Quant Engine_
//     `;

//         await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message, {
//             parse_mode: 'Markdown',
//         });

//         console.log(`✅ Alert dispatched to Telegram for ${data.symbol}`);
//     } catch (error) {
//         console.error(`❌ Failed to send Telegram alert:`, error);
//     }
// };

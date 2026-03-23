import { Telegraf } from 'telegraf';
import { ENV } from '../config/env.js';

const bot = new Telegraf(ENV.TELEGRAM_BOT_TOKEN);

export interface AlertPayload {
    symbol: string;
    price: number;
    percentageChange: number;
    volumeSpikeRatio: number;
    trigger: string;
}

export const sendTelegramAlert = async (data: AlertPayload): Promise<void> => {
    try {
        const message = `
🚨 *QUANT ANOMALY DETECTED* 🚨

📈 *Stock:* ${data.symbol}
💵 *CMP:* ₹${data.price} (${data.percentageChange > 0 ? '+' : ''}${data.percentageChange}%)
🔥 *Volume:* ${data.volumeSpikeRatio * 100}% above average
⚙️ *Trigger:* ${data.trigger}

_System: Fastify Quant Engine_
    `;

        await bot.telegram.sendMessage(ENV.TELEGRAM_CHANNEL_ID, message, {
            parse_mode: 'Markdown',
        });

        console.log(`✅ Alert dispatched to Telegram for ${data.symbol}`);
    } catch (error) {
        console.error(`❌ Failed to send Telegram alert:`, error);
    }
};
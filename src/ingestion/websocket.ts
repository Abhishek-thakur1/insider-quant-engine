import fyersApi from 'fyers-api-v3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENV } from '../config/env.js';

const TOKEN_PATH = path.resolve(process.cwd(), 'access_token.txt');
const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json');

export const startFirehose = () => {
    if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
        console.error("❌ CRITICAL: Missing access_token.txt or watchlist.json. Run auth and universe builder first.");
        process.exit(1);
    }

    const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    const watchlist = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));

    console.log(`[Firehose] 📡 Booting WebSocket Engine...`);


    const wsToken = `${ENV.FYERS_APP_ID}:${accessToken}`;

    const skt = fyersApi.fyersDataSocket.getInstance(wsToken, "./logs", false);
    skt.on("connect", () => {
        console.log("[Firehose] 🟢 WebSocket Connected to Fyers Data Servers!");


        const testBatch = watchlist.slice(0, 100);

        skt.subscribe(testBatch, false);
        console.log(`[Firehose] ✅ Subscribed to ${testBatch.length} symbols. Awaiting ticks...`);
    });

    skt.on("message", (messages: any[]) => {
        if (!messages || messages.length === 0) return;

        messages.forEach(tick => {

            if (tick && tick.symbol) {
                console.log(`⚡ [TICK] ${tick.symbol} | LTP: ₹${tick.ltp} | Vol: ${tick.vol_traded_today}`);
            }
        });
    });

    skt.on("error", (error: any) => console.error("[Firehose] ❌ WebSocket Error:", error));
    skt.on("close", () => console.log("[Firehose] 🔴 WebSocket Closed."));

    skt.autoreconnect(5);
    skt.connect();
};

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFilePath) {
    startFirehose();
}
import fyersApi from 'fyers-api-v3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENV } from '../config/env.js';
import { bootRedis, redisClient } from '../config/redis.js';
import { VcpDetector } from '../detectors/vcpDetector.js';
import { VolumeSpikeDetector } from '../detectors/volumeSpikeDetector.js';
import type { IDetector } from '../core/types.js';

const TOKEN_PATH = path.resolve(process.cwd(), 'access_token.txt');
const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json');

const strategyRouter = new Map<string, IDetector[]>();

const previousVolumeTracker = new Map<string, number>();

export const startLiveEngine = async () => {
    console.log(`[Engine] 📡 Booting Live Quantitative Router...`);

    if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
        console.error("❌ CRITICAL: Missing access_token.txt or watchlist.json.");
        process.exit(1);
    }

    await bootRedis();

    const accessToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    const watchlist: string[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));

    const activeUniverse = watchlist.slice(0, 50);

    console.log(`[Engine] ⚙️ Pre-warming math engines for ${activeUniverse.length} equities...`);
    activeUniverse.forEach(symbol => {
        strategyRouter.set(symbol, [
            new VcpDetector(symbol, 10),
            new VolumeSpikeDetector(symbol, 5)
        ]);
        redisClient.del(`memory:vcp:${symbol}`);
        redisClient.del(`memory:volume:${symbol}`);
        redisClient.del(`cooldown:volume:${symbol}`);
    });

    const wsToken = `${ENV.FYERS_APP_ID}:${accessToken}`;
    const skt = fyersApi.fyersDataSocket.getInstance(wsToken, "./logs", false);

    skt.on("connect", () => {
        console.log("[Firehose] 🟢 Connected to Fyers Data Servers!");
        skt.subscribe(activeUniverse, false);
        console.log(`[Firehose] ✅ Subscribed. Awaiting market ticks...`);
    });

    skt.on("message", async (rawMessage: any) => {
        if (!rawMessage) return;

        let ticks: any[] = [];

        try {
            const parsed = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;

            if (Array.isArray(parsed)) {
                ticks = parsed;
            } else if (parsed && parsed.symbol) {
                ticks = [parsed];
            } else if (parsed && parsed.data && Array.isArray(parsed.data)) {
                ticks = parsed.data;
            } else {
                return;
            }
        } catch (e) {
            return;
        }

        if (ticks.length === 0) return;

        await Promise.all(ticks.map(async (tick) => {
            if (tick && tick.symbol && tick.ltp) {

                const cumulativeVol = tick.vol_traded_today || 0;
                const previousVol = previousVolumeTracker.get(tick.symbol) || cumulativeVol;
                const actualTickVolume = cumulativeVol - previousVol;

                previousVolumeTracker.set(tick.symbol, cumulativeVol);

                if (actualTickVolume > 0) {
                    const liveTick = { price: tick.ltp, volume: actualTickVolume };

                    const strategies = strategyRouter.get(tick.symbol);
                    if (strategies) {
                        await Promise.all(strategies.map(s => s.analyze(liveTick)));
                    }
                }
            }
        }));
    });

    skt.on("error", (error: any) => console.error("[Firehose] ❌ WebSocket Error:", error));
    skt.on("close", () => console.log("[Firehose] 🔴 WebSocket Closed."));

    skt.autoreconnect(5);
    skt.connect();
};

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFilePath) {
    startLiveEngine();
}
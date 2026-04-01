import { sendTelegramAlert } from '../workers/telegramWorker.js';
import type { IDetector, TickData } from '../core/types.js';
import { redisClient } from '../config/redis.js';
import { getVwap } from '../utils/vwapUtils.js';
import { getBestStrike } from '../utils/optionUtils.js';

const CANDLE_DURATION_MS = 60 * 1000; // 1-minute candles for precision scalping
const MEMORY_LENGTH = 5;              // Keep last 5 candles for context
const COOLDOWN_SECONDS = 900;         // 15 min cooldown after a trade
const VWAP_PROXIMITY_PCT = 0.05;      // Candle must touch within 0.05% of VWAP

// Only trade during high-liquidity hours (Ignore first 15 mins and post 2:30 PM)
const getISTMinutes = (): number => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const isActiveWindow = (): boolean => {
    const m = getISTMinutes();
    return m >= 9 * 60 + 30 && m <= 14 * 60 + 30;
};

interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    startTs: number;
}

export class VwapPullbackDetector implements IDetector {
    public name = 'Nifty VWAP Defense Scalp';
    public symbol = 'NSE:NIFTY50-INDEX';

    private currentCandle: Candle | null = null;
    private history: Candle[] = [];

    public async analyze(liveTick: TickData): Promise<void> {
        if (!isActiveWindow() || this.symbol !== 'NSE:NIFTY50-INDEX') return;

        const now = liveTick.timestamp;

        // 1. Build the 1-minute candle
        if (!this.currentCandle) {
            this.currentCandle = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price, volume: liveTick.volume,
                startTs: now,
            };
            return;
        }

        if (now - this.currentCandle.startTs < CANDLE_DURATION_MS) {
            this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price);
            this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price);
            this.currentCandle.close = liveTick.price;
            this.currentCandle.volume += liveTick.volume;
            return;
        }

        // Candle closed. Push to history.
        const closedCandle = { ...this.currentCandle };
        this.currentCandle = {
            open: liveTick.price, high: liveTick.price,
            low: liveTick.price, close: liveTick.price, volume: liveTick.volume,
            startTs: now,
        };

        this.history.push(closedCandle);
        if (this.history.length > MEMORY_LENGTH) this.history.shift();

        // Need at least 3 candles to establish an average volume baseline
        if (this.history.length < 3) return;

        const cooldownKey = `cooldown:nifty_vwap_pullback`;
        if (await redisClient.get(cooldownKey)) return;

        const vwap = await getVwap(this.symbol);
        if (!vwap) return;

        if (this.history.length < 3) return;

        const prevCandle1 = this.history[this.history.length - 2];
        const prevCandle2 = this.history[this.history.length - 3];

        // TypeScript now knows these are definitely Candles and not undefined
        if (!prevCandle1 || !prevCandle2) return;

        const avgRecentVolume = (prevCandle1.volume + prevCandle2.volume) / 2;
        const vwapTolerance = vwap * (VWAP_PROXIMITY_PCT / 100);

        // ── LONG SCALP (CE) - Institutions defending VWAP ──────────────────────────
        // 1. Candle dipped below or touched VWAP
        const touchedVwapLong = closedCandle.low <= vwap + vwapTolerance;
        // 2. Candle rejected the drop and closed ABOVE VWAP (Green candle)
        const closedAboveVwap = closedCandle.close > vwap && closedCandle.close > closedCandle.open;
        // 3. Volume spiked on the rejection (Institutions bought the dip)
        const volumeConfirmedLong = closedCandle.volume > avgRecentVolume * 1.5;

        if (touchedVwapLong && closedAboveVwap && volumeConfirmedLong) {
            const best = getBestStrike('CE', closedCandle.close);
            const indexSl = Number(closedCandle.low.toFixed(2)); // SL is the bottom of the wick
            const risk = closedCandle.close - indexSl;

            // Ignore if risk is too wide (avoid highly volatile anomalous candles)
            if (risk > 25) return;

            const t1 = Number((closedCandle.close + risk * 2).toFixed(2));

            console.log(`\n🛡️ [VWAP DEFENSE CE] Nifty rejected lower prices. Scalping ${best.strike} CE.`);

            sendTelegramAlert({
                symbol: `NIFTY ${best.strike} CE`,
                price: closedCandle.close,
                side: 'LONG',
                percentageChange: 0,
                volumeSpikeRatio: Number((closedCandle.volume / avgRecentVolume).toFixed(1)),
                trigger: `🛡️ VWAP Defense | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${closedCandle.close} | SL ₹${indexSl} (Wick Low) | T1 ₹${t1} | ${best.reason}`,
                vwap,
                avgPrice: closedCandle.close,
            });

            await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
            return;
        }

        // ── SHORT SCALP (PE) - Institutions defending VWAP from below ──────────────
        // 1. Candle pushed up to touch/pierce VWAP
        const touchedVwapShort = closedCandle.high >= vwap - vwapTolerance;
        // 2. Candle rejected the high and closed BELOW VWAP (Red candle)
        const closedBelowVwap = closedCandle.close < vwap && closedCandle.close < closedCandle.open;
        // 3. Volume spiked on the rejection (Institutions sold the rip)
        const volumeConfirmedShort = closedCandle.volume > avgRecentVolume * 1.5;

        if (touchedVwapShort && closedBelowVwap && volumeConfirmedShort) {
            const best = getBestStrike('PE', closedCandle.close);
            const indexSl = Number(closedCandle.high.toFixed(2)); // SL is the top of the wick
            const risk = indexSl - closedCandle.close;

            if (risk > 25) return;

            const t1 = Number((closedCandle.close - risk * 2).toFixed(2));

            console.log(`\n🛡️ [VWAP DEFENSE PE] Nifty rejected higher prices. Scalping ${best.strike} PE.`);

            sendTelegramAlert({
                symbol: `NIFTY ${best.strike} PE`,
                price: closedCandle.close,
                side: 'SHORT',
                percentageChange: 0,
                volumeSpikeRatio: Number((closedCandle.volume / avgRecentVolume).toFixed(1)),
                trigger: `🛡️ VWAP Rejection | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${closedCandle.close} | SL ₹${indexSl} (Wick High) | T1 ₹${t1} | ${best.reason}`,
                vwap,
                avgPrice: closedCandle.close,
            });

            await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
            return;
        }
    }
}
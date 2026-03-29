// ============================================================
//  — Nifty50 Index Options Scalping
//
// Uses live WebSocket ticks from subscribed option strikes to
// dynamically pick the best strike when a signal fires.
//
// Signal logic:
//   Builds 5-min candles on Nifty index.
//   Fires when:
//     1. 3 consecutive candles making HH (CE) or LL (PE)
//     2. Price > 0.15% above/below VWAP
//     3. Latest candle has real body (not a doji)
//     4. Active trading window only
//
// Strike selection:
//   Scans all 14 live subscribed strikes
//   Scores by: OI liquidity + premium momentum + price range + ATM proximity
//   Picks highest scoring strike automatically
// ============================================================

import { sendTelegramAlert } from '../workers/telegramWorker.js';
import type { IDetector, TickData } from '../core/types.js';
import { redisClient } from '../config/redis.js';
import { getVwap } from '../utils/vwapUtils.js';
import { getBestStrike } from '../utils/optionUtils.js';

const CANDLE_DURATION_MS = 5 * 60 * 1000;
const MIN_CANDLE_BODY_PCT = 0.1;
const CONSECUTIVE_CONFIRMS = 3;
const VWAP_DISTANCE_PCT = 0.15;
const COOLDOWN_SECONDS = 900;

const WINDOW_1_START = 9 * 60 + 20;
const WINDOW_1_END = 11 * 60 + 30;
const WINDOW_2_START = 13 * 60 + 30;
const WINDOW_2_END = 15 * 60 + 0;

const getISTMinutes = (): number => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};

const isActiveWindow = (): boolean => {
    const m = getISTMinutes();
    return (m >= WINDOW_1_START && m <= WINDOW_1_END) ||
        (m >= WINDOW_2_START && m <= WINDOW_2_END);
};

interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
    startTs: number;
}

export class NiftyOptionsDetector implements IDetector {
    public name = 'Nifty Options Scalper';
    public symbol = 'NSE:NIFTY50-INDEX';

    private currentCandle: Candle | null = null;
    private completedCandles: Candle[] = [];

    public async analyze(liveTick: TickData): Promise<void> {
        if (!isActiveWindow()) return;

        const now = liveTick.timestamp;

        if (!this.currentCandle) {
            this.currentCandle = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price,
                startTs: now,
            };
            return;
        }

        if (now - this.currentCandle.startTs < CANDLE_DURATION_MS) {
            this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price);
            this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price);
            this.currentCandle.close = liveTick.price;
            return;
        }

        const closed = { ...this.currentCandle };
        this.currentCandle = {
            open: liveTick.price, high: liveTick.price,
            low: liveTick.price, close: liveTick.price,
            startTs: now,
        };

        this.completedCandles.push(closed);
        if (this.completedCandles.length > CONSECUTIVE_CONFIRMS + 1) {
            this.completedCandles.shift();
        }
        if (this.completedCandles.length < CONSECUTIVE_CONFIRMS) return;

        const cooldownKey = `cooldown:nifty_options`;
        if (await redisClient.get(cooldownKey)) return;

        const vwap = await getVwap(this.symbol);
        if (!vwap) return;

        const recent = this.completedCandles.slice(-CONSECUTIVE_CONFIRMS);
        const price = closed.close;
        const bodyPct = Math.abs(closed.close - closed.open) / closed.open * 100;
        const isRealBody = bodyPct >= MIN_CANDLE_BODY_PCT;

        // ── LONG — CE ────────────────────────────────────────────────────
        const isAboveVwap = ((price - vwap) / vwap) * 100 >= VWAP_DISTANCE_PCT;
        const isHigherHighs = recent.every((c, i) => i === 0 || c.high > recent[i - 1]!.high);
        const isBullish = closed.close > closed.open;

        if (isAboveVwap && isHigherHighs && isBullish && isRealBody) {
            const best = getBestStrike('CE', price);
            const indexSl = Number((vwap * 0.999).toFixed(2));
            const risk = price - indexSl;
            const t1 = Number((price + risk * 1.5).toFixed(2));
            const t2 = Number((price + risk * 2.5).toFixed(2));

            console.log(`\n🎯 [NIFTY CE SCALP] ${best.strike} CE | Premium ₹${best.ltp} | ${best.reason}`);

            sendTelegramAlert({
                symbol: `NIFTY ${best.strike} CE`,
                price,
                side: 'LONG',
                percentageChange: Number((((price - vwap) / vwap) * 100).toFixed(2)),
                volumeSpikeRatio: CONSECUTIVE_CONFIRMS,
                trigger: `🎯 Nifty Scalp CE | Strike ${best.strike} | Premium ~₹${best.ltp > 0 ? best.ltp.toFixed(0) : 'loading'} | Index ₹${price} | SL ₹${indexSl} | T1 ₹${t1} | T2 ₹${t2} | ⏱ Exit 15min | ${best.reason}`,
                vwap,
                avgPrice: (closed.open + closed.close) / 2,
            });

            await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
            return;
        }

        // ── SHORT — PE ───────────────────────────────────────────────────
        const isBelowVwap = ((vwap - price) / vwap) * 100 >= VWAP_DISTANCE_PCT;
        const isLowerLows = recent.every((c, i) => i === 0 || c.low < recent[i - 1]!.low);
        const isBearish = closed.close < closed.open;

        if (isBelowVwap && isLowerLows && isBearish && isRealBody) {
            const best = getBestStrike('PE', price);
            const indexSl = Number((vwap * 1.001).toFixed(2));
            const risk = indexSl - price;
            const t1 = Number((price - risk * 1.5).toFixed(2));
            const t2 = Number((price - risk * 2.5).toFixed(2));

            console.log(`\n🎯 [NIFTY PE SCALP] ${best.strike} PE | Premium ₹${best.ltp} | ${best.reason}`);

            sendTelegramAlert({
                symbol: `NIFTY ${best.strike} PE`,
                price,
                side: 'SHORT',
                percentageChange: Number((((vwap - price) / vwap) * 100).toFixed(2)),
                volumeSpikeRatio: CONSECUTIVE_CONFIRMS,
                trigger: `🎯 Nifty Scalp PE | Strike ${best.strike} | Premium ~₹${best.ltp > 0 ? best.ltp.toFixed(0) : 'loading'} | Index ₹${price} | SL ₹${indexSl} | T1 ₹${t1} | T2 ₹${t2} | ⏱ Exit 15min | ${best.reason}`,
                vwap,
                avgPrice: (closed.open + closed.close) / 2,
            });

            await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
            return;
        }

        return;
    }
}
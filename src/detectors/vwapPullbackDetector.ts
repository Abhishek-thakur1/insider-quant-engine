
import { sendTelegramAlert } from '../workers/telegramWorker.js';
import type { IDetector, TickData } from '../core/types.js';
import { redisClient } from '../config/redis.js';
import { getVwap, getMarketBias } from '../utils/vwapUtils.js';
import { getBestStrike } from '../utils/optionUtils.js';

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_DURATION_MS = 60 * 1000; // 1-minute candles
const MEMORY_LENGTH = 6;         // last 6 candles for context + volume baseline
const COOLDOWN_SECONDS = 900;       // 15 min cooldown
const VWAP_PROXIMITY_PCT = 0.12;      // candle must touch within 0.12% of VWAP (~27pts on 22800)
const VOL_MULTIPLIER = 1.8;       // rejection candle must be 1.8× avg vol
const MAX_RISK_POINTS = 30;        // ignore if SL > 30 points away (too wide)
const MIN_BODY_POINTS = 5;         // candle body must be at least 5 points (not a doji)
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};

// Avoid first 15 min chaos and post 2:30 PM low-liquidity
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
        if (!isActiveWindow()) return;

        const now = liveTick.timestamp;

        // ── Build 1-min candle ───────────────────────────────────────────
        if (!this.currentCandle) {
            this.currentCandle = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price,
                volume: liveTick.volume, startTs: now,
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

        // ── Candle closed ────────────────────────────────────────────────
        const c = { ...this.currentCandle }; // closed candle
        this.currentCandle = {
            open: liveTick.price, high: liveTick.price,
            low: liveTick.price, close: liveTick.price,
            volume: liveTick.volume, startTs: now,
        };

        this.history.push(c);
        if (this.history.length > MEMORY_LENGTH) this.history.shift();

        // Need at least 4 candles — 3 for baseline vol + 1 for trend context
        if (this.history.length < 4) return;

        const cooldownKey = `cooldown:nifty_vwap_pullback`;
        if (await redisClient.get(cooldownKey)) return;

        const vwap = await getVwap(this.symbol);
        if (!vwap) return;

        const marketBias = await getMarketBias();

        // ── Volume baseline — use all history except the current candle ──
        const baseline = this.history.slice(0, -1); // exclude just-closed candle
        const avgVol = baseline.reduce((a, x) => a + x.volume, 0) / baseline.length;

        // ── Tolerance band around VWAP ───────────────────────────────────
        const tolerance = vwap * (VWAP_PROXIMITY_PCT / 100);

        // ── Candle body size ─────────────────────────────────────────────
        const bodySize = Math.abs(c.close - c.open);
        const isRealBody = bodySize >= MIN_BODY_POINTS;

        // ── Trend context — prior candle must agree with direction ────────
        const priorCandle = this.history[this.history.length - 2]!;
        const priorBullish = priorCandle.close > priorCandle.open;
        const priorBearish = priorCandle.close < priorCandle.open;

        // ── LONG SCALP (CE) ──────────────────────────────────────────────
        // Conditions:
        //   1. Candle wick touched VWAP from above (low came within tolerance)
        //   2. Candle closed GREEN above VWAP (rejection confirmed)
        //   3. Real body — not a doji
        //   4. Volume spike — institutions stepped in
        //   5. Prior candle was also bullish OR market bias is bullish (trend context)
        //   6. Market not bearish

        const touchedVwapLong = c.low <= vwap + tolerance && c.low >= vwap - tolerance * 3;
        const closedAboveVwap = c.close > vwap && c.close > c.open;
        const volConfirmedLong = c.volume > avgVol * VOL_MULTIPLIER;
        const trendOkLong = priorBullish || marketBias === 'bullish';

        if (touchedVwapLong && closedAboveVwap && isRealBody && volConfirmedLong && trendOkLong && marketBias !== 'bearish') {
            const indexSl = Number(c.low.toFixed(2));
            const risk = c.close - indexSl;
            if (risk > MAX_RISK_POINTS || risk <= 0) return;

            const t1 = Number((c.close + risk * 1.5).toFixed(2));
            const t2 = Number((c.close + risk * 2.5).toFixed(2));
            const best = getBestStrike('CE', c.close);

            console.log(`\n🛡️ [VWAP DEFENSE CE] Nifty defended VWAP at ₹${vwap.toFixed(2)} | Strike ${best.strike}`);

            sendTelegramAlert({
                symbol: `NIFTY ${best.strike} CE`,
                price: c.close,
                side: 'LONG',
                percentageChange: Number((((c.close - vwap) / vwap) * 100).toFixed(2)),
                volumeSpikeRatio: Number((c.volume / avgVol).toFixed(1)),
                trigger: `🛡️ VWAP Defense CE | Strike ${best.strike} | Prem ~₹${best.ltp > 0 ? best.ltp.toFixed(0) : 'loading'} | Index ₹${c.close} | SL ₹${indexSl} | T1 ₹${t1} | T2 ₹${t2} | ${best.reason}`,
                vwap,
                avgPrice: (c.open + c.close) / 2,
            });

            await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
            return;
        }

        // ── SHORT SCALP (PE) ─────────────────────────────────────────────
        // Conditions:
        //   1. Candle wick touched VWAP from below (high came within tolerance)
        //   2. Candle closed RED below VWAP (rejection confirmed)
        //   3. Real body — not a doji
        //   4. Volume spike — institutions sold the rip
        //   5. Prior candle was also bearish OR market bias is bearish (trend context)
        //   6. Market not bullish

        const touchedVwapShort = c.high >= vwap - tolerance && c.high <= vwap + tolerance * 3;
        const closedBelowVwap = c.close < vwap && c.close < c.open;
        const volConfirmedShort = c.volume > avgVol * VOL_MULTIPLIER;
        const trendOkShort = priorBearish || marketBias === 'bearish';

        if (touchedVwapShort && closedBelowVwap && isRealBody && volConfirmedShort && trendOkShort && marketBias !== 'bullish') {
            const indexSl = Number(c.high.toFixed(2));
            const risk = indexSl - c.close;
            if (risk > MAX_RISK_POINTS || risk <= 0) return;

            const t1 = Number((c.close - risk * 1.5).toFixed(2));
            const t2 = Number((c.close - risk * 2.5).toFixed(2));
            const best = getBestStrike('PE', c.close);

            console.log(`\n🛡️ [VWAP DEFENSE PE] Nifty rejected VWAP at ₹${vwap.toFixed(2)} | Strike ${best.strike}`);

            sendTelegramAlert({
                symbol: `NIFTY ${best.strike} PE`,
                price: c.close,
                side: 'SHORT',
                percentageChange: Number((((vwap - c.close) / vwap) * 100).toFixed(2)),
                volumeSpikeRatio: Number((c.volume / avgVol).toFixed(1)),
                trigger: `🛡️ VWAP Rejection PE | Strike ${best.strike} | Prem ~₹${best.ltp > 0 ? best.ltp.toFixed(0) : 'loading'} | Index ₹${c.close} | SL ₹${indexSl} | T1 ₹${t1} | T2 ₹${t2} | ${best.reason}`,
                vwap,
                avgPrice: (c.open + c.close) / 2,
            });

            await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
            return;
        }
    }
}

// import { sendTelegramAlert } from '../workers/telegramWorker.js';
// import type { IDetector, TickData } from '../core/types.js';
// import { redisClient } from '../config/redis.js';
// import { getVwap } from '../utils/vwapUtils.js';
// import { getBestStrike } from '../utils/optionUtils.js';

// const CANDLE_DURATION_MS = 60 * 1000; // 1-minute candles for precision scalping
// const MEMORY_LENGTH = 5;              // Keep last 5 candles for context
// const COOLDOWN_SECONDS = 900;         // 15 min cooldown after a trade
// const VWAP_PROXIMITY_PCT = 0.05;      // Candle must touch within 0.05% of VWAP

// // Only trade during high-liquidity hours (Ignore first 15 mins and post 2:30 PM)
// const getISTMinutes = (): number => {
//     const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
//     return d.getUTCHours() * 60 + d.getUTCMinutes();
// };
// const isActiveWindow = (): boolean => {
//     const m = getISTMinutes();
//     return m >= 9 * 60 + 30 && m <= 14 * 60 + 30;
// };

// interface Candle {
//     open: number;
//     high: number;
//     low: number;
//     close: number;
//     volume: number;
//     startTs: number;
// }

// export class VwapPullbackDetector implements IDetector {
//     public name = 'Nifty VWAP Defense Scalp';
//     public symbol = 'NSE:NIFTY50-INDEX';

//     private currentCandle: Candle | null = null;
//     private history: Candle[] = [];

//     public async analyze(liveTick: TickData): Promise<void> {
//         if (!isActiveWindow() || this.symbol !== 'NSE:NIFTY50-INDEX') return;

//         const now = liveTick.timestamp;

//         // 1. Build the 1-minute candle
//         if (!this.currentCandle) {
//             this.currentCandle = {
//                 open: liveTick.price, high: liveTick.price,
//                 low: liveTick.price, close: liveTick.price, volume: liveTick.volume,
//                 startTs: now,
//             };
//             return;
//         }

//         if (now - this.currentCandle.startTs < CANDLE_DURATION_MS) {
//             this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price);
//             this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price);
//             this.currentCandle.close = liveTick.price;
//             this.currentCandle.volume += liveTick.volume;
//             return;
//         }

//         // Candle closed. Push to history.
//         const closedCandle = { ...this.currentCandle };
//         this.currentCandle = {
//             open: liveTick.price, high: liveTick.price,
//             low: liveTick.price, close: liveTick.price, volume: liveTick.volume,
//             startTs: now,
//         };

//         this.history.push(closedCandle);
//         if (this.history.length > MEMORY_LENGTH) this.history.shift();

//         // Need at least 3 candles to establish an average volume baseline
//         if (this.history.length < 3) return;

//         const cooldownKey = `cooldown:nifty_vwap_pullback`;
//         if (await redisClient.get(cooldownKey)) return;

//         const vwap = await getVwap(this.symbol);
//         if (!vwap) return;

//         if (this.history.length < 3) return;

//         const prevCandle1 = this.history[this.history.length - 2];
//         const prevCandle2 = this.history[this.history.length - 3];

//         // TypeScript now knows these are definitely Candles and not undefined
//         if (!prevCandle1 || !prevCandle2) return;

//         const avgRecentVolume = (prevCandle1.volume + prevCandle2.volume) / 2;
//         const vwapTolerance = vwap * (VWAP_PROXIMITY_PCT / 100);

//         // ── LONG SCALP (CE) - Institutions defending VWAP ──────────────────────────
//         // 1. Candle dipped below or touched VWAP
//         const touchedVwapLong = closedCandle.low <= vwap + vwapTolerance;
//         // 2. Candle rejected the drop and closed ABOVE VWAP (Green candle)
//         const closedAboveVwap = closedCandle.close > vwap && closedCandle.close > closedCandle.open;
//         // 3. Volume spiked on the rejection (Institutions bought the dip)
//         const volumeConfirmedLong = closedCandle.volume > avgRecentVolume * 1.5;

//         if (touchedVwapLong && closedAboveVwap && volumeConfirmedLong) {
//             const best = getBestStrike('CE', closedCandle.close);
//             const indexSl = Number(closedCandle.low.toFixed(2)); // SL is the bottom of the wick
//             const risk = closedCandle.close - indexSl;

//             // Ignore if risk is too wide (avoid highly volatile anomalous candles)
//             if (risk > 25) return;

//             const t1 = Number((closedCandle.close + risk * 2).toFixed(2));

//             console.log(`\n🛡️ [VWAP DEFENSE CE] Nifty rejected lower prices. Scalping ${best.strike} CE.`);

//             sendTelegramAlert({
//                 symbol: `NIFTY ${best.strike} CE`,
//                 price: closedCandle.close,
//                 side: 'LONG',
//                 percentageChange: 0,
//                 volumeSpikeRatio: Number((closedCandle.volume / avgRecentVolume).toFixed(1)),
//                 trigger: `🛡️ VWAP Defense | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${closedCandle.close} | SL ₹${indexSl} (Wick Low) | T1 ₹${t1} | ${best.reason}`,
//                 vwap,
//                 avgPrice: closedCandle.close,
//             });

//             await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
//             return;
//         }

//         // ── SHORT SCALP (PE) - Institutions defending VWAP from below ──────────────
//         // 1. Candle pushed up to touch/pierce VWAP
//         const touchedVwapShort = closedCandle.high >= vwap - vwapTolerance;
//         // 2. Candle rejected the high and closed BELOW VWAP (Red candle)
//         const closedBelowVwap = closedCandle.close < vwap && closedCandle.close < closedCandle.open;
//         // 3. Volume spiked on the rejection (Institutions sold the rip)
//         const volumeConfirmedShort = closedCandle.volume > avgRecentVolume * 1.5;

//         if (touchedVwapShort && closedBelowVwap && volumeConfirmedShort) {
//             const best = getBestStrike('PE', closedCandle.close);
//             const indexSl = Number(closedCandle.high.toFixed(2)); // SL is the top of the wick
//             const risk = indexSl - closedCandle.close;

//             if (risk > 25) return;

//             const t1 = Number((closedCandle.close - risk * 2).toFixed(2));

//             console.log(`\n🛡️ [VWAP DEFENSE PE] Nifty rejected higher prices. Scalping ${best.strike} PE.`);

//             sendTelegramAlert({
//                 symbol: `NIFTY ${best.strike} PE`,
//                 price: closedCandle.close,
//                 side: 'SHORT',
//                 percentageChange: 0,
//                 volumeSpikeRatio: Number((closedCandle.volume / avgRecentVolume).toFixed(1)),
//                 trigger: `🛡️ VWAP Rejection | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${closedCandle.close} | SL ₹${indexSl} (Wick High) | T1 ₹${t1} | ${best.reason}`,
//                 vwap,
//                 avgPrice: closedCandle.close,
//             });

//             await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
//             return;
//         }
//     }
// }
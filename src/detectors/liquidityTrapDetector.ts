import { sendTelegramAlert } from '../workers/telegramWorker.js';
import type { IDetector, TickData } from '../core/types.js';
import { redisClient } from '../config/redis.js';
import { getVwap, getMarketBias } from '../utils/vwapUtils.js';

const CANDLE_DURATION_MS = 60 * 1000;  // 1-minute candles
const MEMORY_CANDLES = 15;             // Look back 15 mins for the local high/low
const COOLDOWN_SECONDS = 1800;         // 30 min cooldown per symbol
const MIN_WICK_PCT = 0.4;              // Wick must be at least 40% of the total candle size
const VOL_MULTIPLIER = 2.5;            // Rejection volume > 2.5x average

interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    startTs: number;
}

const getISTMinutes = (): number => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const isMarketHours = (): boolean => {
    const m = getISTMinutes();
    return m >= (9 * 60 + 30) && m <= (15 * 60);
};

export class LiquidityTrapDetector implements IDetector {
    public name = "Institutional Liquidity Sweep (Trap)";
    public symbol: string;

    private currentCandle: Candle | null = null;

    constructor(symbol: string) {
        this.symbol = symbol;
    }

    public async analyze(liveTick: TickData): Promise<void> {
        if (!isMarketHours()) return;

        const now = liveTick.timestamp;

        if (!this.currentCandle) {
            this.currentCandle = {
                open: liveTick.price, high: liveTick.price,
                low: liveTick.price, close: liveTick.price, volume: liveTick.volume,
                startTs: now,
            };
            return;
        }

        const candleAge = now - this.currentCandle.startTs;

        if (candleAge < CANDLE_DURATION_MS) {
            this.currentCandle.high = Math.max(this.currentCandle.high, liveTick.price);
            this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price);
            this.currentCandle.close = liveTick.price;
            this.currentCandle.volume += liveTick.volume;
            return;
        }

        // Candle is closed
        const closedCandle = { ...this.currentCandle };

        // Reset for next candle
        this.currentCandle = {
            open: liveTick.price, high: liveTick.price,
            low: liveTick.price, close: liveTick.price, volume: liveTick.volume,
            startTs: now,
        };

        const candleKey = `trap_candles:${this.symbol}`;
        const cooldownKey = `cooldown:trap:${this.symbol}`;

        if (await redisClient.get(cooldownKey)) {
            await redisClient.multi()
                .lPush(candleKey, JSON.stringify(closedCandle))
                .lTrim(candleKey, 0, MEMORY_CANDLES)
                .exec();
            return;
        }

        const rawCandles = await redisClient.lRange(candleKey, 0, -1);
        const history: Candle[] = rawCandles.map(c => JSON.parse(c) as Candle);

        if (history.length >= 10) { // Need at least 10 mins of context
            const recentHigh = Math.max(...history.map(c => c.high));
            const recentLow = Math.min(...history.map(c => c.low));
            const avgVol = history.reduce((a, c) => a + c.volume, 0) / history.length;

            const vwap = await getVwap(this.symbol);
            const marketBias = await getMarketBias();

            const candleRange = closedCandle.high - closedCandle.low;
            if (candleRange === 0) return; // Prevent division by zero

            const upperWick = closedCandle.high - Math.max(closedCandle.open, closedCandle.close);
            const lowerWick = Math.min(closedCandle.open, closedCandle.close) - closedCandle.low;

            const upperWickPct = upperWick / candleRange;
            const lowerWickPct = lowerWick / candleRange;

            // ── SHORT TRAP: Swept the Highs, Closed Low ──────────────────────────
            // Pierced recent high, but closed below it. Long upper wick.
            const sweptHighs = closedCandle.high > recentHigh;
            const closedBelowHighs = closedCandle.close < recentHigh;
            const isBearishRejection = upperWickPct >= MIN_WICK_PCT && closedCandle.close < closedCandle.open;

            if (sweptHighs && closedBelowHighs && isBearishRejection && closedCandle.volume > avgVol * VOL_MULTIPLIER) {
                if (vwap !== null && closedCandle.close < vwap && marketBias !== 'bullish') {

                    const sl = Number((closedCandle.high + 0.5).toFixed(2)); // SL just above the wick
                    const risk = sl - closedCandle.close;

                    console.log(`\n🕷️ [LIQUIDITY TRAP SHORT] ${this.symbol} trapped breakout buyers.`);

                    sendTelegramAlert({
                        symbol: this.symbol,
                        price: closedCandle.close,
                        side: 'SHORT',
                        percentageChange: 0,
                        volumeSpikeRatio: Number((closedCandle.volume / avgVol).toFixed(1)),
                        trigger: `🕷️ Bull Trap | Swept ₹${recentHigh.toFixed(2)} & Rejected | SL above wick: ₹${sl} | Vol ${Number((closedCandle.volume / avgVol).toFixed(1))}x`,
                        vwap: vwap ?? closedCandle.close,
                        avgPrice: closedCandle.close,
                    });

                    await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
                }
            }

            // ── LONG TRAP: Swept the Lows, Closed High ──────────────────────────
            // Pierced recent low, but closed above it. Long lower wick.
            const sweptLows = closedCandle.low < recentLow;
            const closedAboveLows = closedCandle.close > recentLow;
            const isBullishRejection = lowerWickPct >= MIN_WICK_PCT && closedCandle.close > closedCandle.open;

            if (sweptLows && closedAboveLows && isBullishRejection && closedCandle.volume > avgVol * VOL_MULTIPLIER) {
                if (vwap !== null && closedCandle.close > vwap && marketBias !== 'bearish') {

                    const sl = Number((closedCandle.low - 0.5).toFixed(2)); // SL just below the wick
                    const risk = closedCandle.close - sl;

                    console.log(`\n🕷️ [LIQUIDITY TRAP LONG] ${this.symbol} trapped short sellers.`);

                    sendTelegramAlert({
                        symbol: this.symbol,
                        price: closedCandle.close,
                        side: 'LONG',
                        percentageChange: 0,
                        volumeSpikeRatio: Number((closedCandle.volume / avgVol).toFixed(1)),
                        trigger: `🕷️ Bear Trap | Swept ₹${recentLow.toFixed(2)} & Rejected | SL below wick: ₹${sl} | Vol ${Number((closedCandle.volume / avgVol).toFixed(1))}x`,
                        vwap: vwap ?? closedCandle.close,
                        avgPrice: closedCandle.close,
                    });

                    await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
                }
            }
        }

        await redisClient.multi()
            .lPush(candleKey, JSON.stringify(closedCandle))
            .lTrim(candleKey, 0, MEMORY_CANDLES)
            .exec();
    }
}
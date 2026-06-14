import { redisClient } from "../../../config/redis.js";
import type { IDetector, TickData } from "../../../core/types.js";
import { sendTelegramAlert, type AlertPayload } from "../../../workers/telegramWorker.js";


export abstract class BaseDetector implements IDetector {
    public name: string;
    public symbol: string;

    constructor(symbol: string, name: string) {
        this.symbol = symbol;
        this.name = name;
    }

    /**
     * The HTF Filter: Prevents buying intraday breakouts when the Daily chart is bearish.
     * Assumes a separate seeder populates 'HTF_TREND:SYMBOL' with 'BULLISH' or 'BEARISH'.
     * Fails OPEN (returns true) if no trend is seeded so you don't miss trades.
     */
    protected async isDailyTrendAligned(direction: 'BULLISH' | 'BEARISH'): Promise<boolean> {
        const trend = await redisClient.get(`HTF_TREND:${this.symbol}`);
        if (!trend) return true; // Fail-open if no seeder exists yet
        return trend === direction;
    }

    protected async triggerAlert(payload: AlertPayload): Promise<void> {
        await sendTelegramAlert(payload);
    }

    // Every specific strategy must implement this tick processor
    abstract analyze(liveTick: TickData): Promise<void>;
}
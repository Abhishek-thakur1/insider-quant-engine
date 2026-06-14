import { redisClient } from "../../../config/redis.js";
import type { TickData } from "../../../core/types.js";
import { getVwap } from "../../../utils/vwapUtils.js";
import { BaseDetector } from "./baseDetector.js";


export class GapAndGoMomentum extends BaseDetector {
    constructor(symbol: string) {
        super(symbol, 'Gap_And_Go_V2');
    }

    async analyze(liveTick: TickData): Promise<void> {
        const now = new Date(liveTick.timestamp + 5.5 * 60 * 60 * 1000);
        const m = now.getUTCHours() * 60 + now.getUTCMinutes();

        // Only active during the prime momentum window (9:30 AM to 10:15 AM)
        if (m < 9 * 60 + 30 || m > 10 * 60 + 15) return;

        const cooldownKey = `v2:cooldown:gapgo:${this.symbol}`;
        if (await redisClient.get(cooldownKey)) return;

        // Fetch ORB parameters from Redis
        const orhRaw = await redisClient.get(`orb:15min:high:${this.symbol}`);
        const orlRaw = await redisClient.get(`orb:15min:low:${this.symbol}`);
        if (!orhRaw || !orlRaw) return;

        const orh = parseFloat(orhRaw);
        const orl = parseFloat(orlRaw);
        const rangeSpread = ((orh - orl) / orl) * 100;

        const vwap = await getVwap(this.symbol);
        if (!vwap) return;

        // 1. Must be holding cleanly above VWAP
        if (liveTick.price < vwap) return;

        // 2. Strong opening range logic (Avoid overly tight or massive choppy ranges)
        if (rangeSpread < 0.5 || rangeSpread > 2.5) return;

        // 3. Trigger: Clean break of ORH with Block Sized Volume
        const blockValue = liveTick.price * liveTick.volume;
        const isBlockSized = blockValue >= 5_000_000; // ₹50L minimum

        if (liveTick.price > orh * 1.002 && isBlockSized) {
            console.log(`\n🏎️ [V2 GAP AND GO] ${this.symbol} blasting past ORH at ₹${orh}`);

            await this.triggerAlert({
                symbol: this.symbol,
                price: liveTick.price,
                side: 'LONG',
                percentageChange: Number((((liveTick.price - orh) / orh) * 100).toFixed(2)),
                volumeSpikeRatio: 2.0, // Assumed strong on block
                trigger: `🏎️💨 Gap & Go | ORH ₹${orh.toFixed(2)} Broken | VWAP Defense Firm | Institutional Block Detected`,
                vwap: vwap,
                avgPrice: orh
            });

            // One shot per day
            await redisClient.setEx(cooldownKey, 28800, '1');
        }
    }
}
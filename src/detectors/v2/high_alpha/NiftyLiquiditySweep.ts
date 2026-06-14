import { redisClient } from "../../../config/redis.js";
import type { TickData } from "../../../core/types.js";
import { getBestStrike } from "../../../utils/optionUtils.js";
import { getVwap } from "../../../utils/vwapUtils.js";
import { BaseDetector } from "./baseDetector.js";


const COOLDOWN_SECONDS = 3600;

export class NiftyLiquiditySweep extends BaseDetector {
    constructor() {
        // Runs specifically as a Nifty Singleton
        super('NSE:NIFTY50-INDEX', 'Nifty_Liquidity_Sweep_V2');
    }

    async analyze(liveTick: TickData): Promise<void> {
        if (this.symbol !== 'NSE:NIFTY50-INDEX') return;

        const now = new Date(liveTick.timestamp + 5.5 * 60 * 60 * 1000);
        const m = now.getUTCHours() * 60 + now.getUTCMinutes();

        // Active from 9:45 AM (after ORB locks) to 2:30 PM
        if (m < 9 * 60 + 45 || m > 14 * 60 + 30) return;

        const cooldownKey = `v2:cooldown:nifty_sweep`;
        if (await redisClient.get(cooldownKey)) return;

        // Fetch the 30-min Opening Range High (created by your OrbDetector)
        const orhRaw = await redisClient.get(`orb:30min:high:${this.symbol}`);
        if (!orhRaw) return;
        const orh = parseFloat(orhRaw);

        // State Machine via Redis (survives pm2/docker restarts)
        const stateKey = `v2:state:nifty_sweep`;
        const currentState = await redisClient.get(stateKey) || 'WAITING';

        const vwap = await getVwap(this.symbol) || liveTick.price;

        switch (currentState) {
            case 'WAITING':
                // Retail triggers breakout buys
                if (liveTick.price > orh + 5) {
                    await redisClient.set(stateKey, 'SWEPT_HIGH');
                    await redisClient.set(`${stateKey}:time`, String(liveTick.timestamp));
                }
                break;

            case 'SWEPT_HIGH':
                const sweepTimeRaw = await redisClient.get(`${stateKey}:time`);
                const sweepTime = sweepTimeRaw ? parseInt(sweepTimeRaw) : liveTick.timestamp;

                // Invalidate if it stays above the breakout level for > 30 mins (It's a real trend)
                if (liveTick.timestamp - sweepTime > 30 * 60 * 1000) {
                    await redisClient.set(stateKey, 'WAITING');
                    return;
                }

                // THE TRAP: Price falls back below ORH. Mark structural low.
                if (liveTick.price < orh - 5) {
                    await redisClient.set(stateKey, 'TRAP_FORMED');
                    await redisClient.set(`${stateKey}:trapLow`, String(liveTick.price));
                }
                break;

            case 'TRAP_FORMED':
                const trapLowRaw = await redisClient.get(`${stateKey}:trapLow`);
                const trapLow = trapLowRaw ? parseFloat(trapLowRaw) : liveTick.price;

                // Invalidation: Price re-sweeps the highs.
                if (liveTick.price > orh) {
                    await redisClient.set(stateKey, 'SWEPT_HIGH');
                    return;
                }

                // CONFIRMATION: Price breaks below the structural trap low. Retail stops hit.
                if (liveTick.price < trapLow - 2) {
                    const bestStrike = getBestStrike('PE', liveTick.price);

                    // Options require custom trigger string as per your telegramWorker
                    const sl = Math.round(orh + 5);
                    const risk = sl - liveTick.price;
                    const t1 = Math.round(liveTick.price - (risk * 2));

                    console.log(`\n🎯 [V2 NIFTY SWEEP] Retail trapped at ORH. Routing ${bestStrike.strike} PE.`);

                    await this.triggerAlert({
                        symbol: `NIFTY ${bestStrike.strike} PE`,
                        price: liveTick.price,
                        side: 'SHORT',
                        percentageChange: Number((((liveTick.price - vwap) / vwap) * 100).toFixed(2)),
                        volumeSpikeRatio: 1, // Spot has no vol
                        trigger: `🪤 ORH Liquidity Sweep Trap | Premium ~₹${bestStrike.ltp > 0 ? bestStrike.ltp : 'N/A'} | Index ₹${liveTick.price} | SL ₹${sl} | Target ₹${t1} | ${bestStrike.reason}`,
                        vwap: vwap,
                        avgPrice: liveTick.price
                    });

                    await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
                    await redisClient.del(stateKey); // Reset state
                }
                break;
        }
    }
}
import { sendTelegramAlert } from '../workers/telegramWorker.js';
import type { IDetector, TickData } from '../core/types.js';
import { redisClient } from '../config/redis.js';

export class VcpDetector implements IDetector {
    public name: string = "VCP Breakout";
    public symbol: string;

    private memoryLength: number;
    private isArmed: boolean = false;

    constructor(symbol: string, memoryLength: number = 10) {
        this.symbol = symbol;
        this.memoryLength = memoryLength;
    }

    public async analyze(liveTick: TickData): Promise<void> {
        const redisKey = `memory:vcp:${this.symbol}`;

        const rawMemory = await redisClient.lRange(redisKey, 0, -1);

        const tickHistory: TickData[] = rawMemory.map(item => JSON.parse(item));

        if (tickHistory.length === this.memoryLength) {
            const prices = tickHistory.map(t => t.price);
            const volumes = tickHistory.map(t => t.volume);

            const boxHigh = Math.max(...prices);
            const boxLow = Math.min(...prices);
            const spreadPercent = ((boxHigh - boxLow) / boxLow) * 100;
            const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

            if (this.isArmed) {
                const isBreakingResistance = liveTick.price > boxHigh;
                const isVolumeExplosion = liveTick.volume > (avgVolume * 5);

                if (isBreakingResistance && isVolumeExplosion) {
                    console.log(`\n🔥 [TRIGGER] INSTITUTIONAL BUYING DETECTED IN ${this.symbol}!`);

                    sendTelegramAlert({
                        symbol: this.symbol,
                        price: liveTick.price,
                        percentageChange: Number((((liveTick.price - boxLow) / boxLow) * 100).toFixed(2)),
                        volumeSpikeRatio: Number((liveTick.volume / avgVolume).toFixed(1)),
                        trigger: "📦 VCP Breakout / Supply Evaporation"
                    });

                    this.isArmed = false;

                    await redisClient.del(redisKey);
                    return;
                }
            }

            if (spreadPercent < 0.5 && !this.isArmed) {
                this.isArmed = true;
                console.log(`\n🔒 [VCP SYSTEM] ${this.symbol} is coiled. Spread: ${spreadPercent.toFixed(2)}%. Avg Vol: ${avgVolume.toFixed(0)}. Armed and waiting...`);
            } else if (spreadPercent >= 0.5 && this.isArmed) {
                this.isArmed = false;
                console.log(`\n🔓 [VCP SYSTEM] ${this.symbol} spread widened without breakout. Disarming.`);
            }
        }

        await redisClient.lPush(redisKey, JSON.stringify(liveTick));
        await redisClient.lTrim(redisKey, 0, this.memoryLength - 1);
    }
}
import { sendTelegramAlert } from '../workers/telegramWorker.js';
import type { IDetector, TickData } from '../core/types.js';
import { redisClient } from '../config/redis.js';

export class VolumeSpikeDetector implements IDetector {
    public name: string = "Volume Squeeze & Spike";
    public symbol: string;

    private memoryLength: number;

    constructor(symbol: string, memoryLength: number = 5) {
        this.symbol = symbol;
        this.memoryLength = memoryLength;
    }

    public async analyze(liveTick: TickData): Promise<void> {
        const memoryKey = `memory:volume:${this.symbol}`;
        const cooldownKey = `cooldown:volume:${this.symbol}`;

        const rawMemory = await redisClient.lRange(memoryKey, 0, -1);
        const tickHistory: TickData[] = rawMemory.map(item => JSON.parse(item));


        const isCoolingDown = await redisClient.get(cooldownKey);

        if (tickHistory.length === this.memoryLength && !isCoolingDown) {
            const volumes = tickHistory.map(t => t.volume);
            const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

            const lastTick = tickHistory[0];

            if (lastTick) {
                const isVolumeSurge = liveTick.volume > (avgVolume * 4);
                const isBullish = liveTick.price > lastTick.price;

                if (isVolumeSurge && isBullish) {
                    console.log(`\n🌊 [VOLUME DETECTOR] Massive block buying in ${this.symbol}!`);

                    sendTelegramAlert({
                        symbol: this.symbol,
                        price: liveTick.price,
                        percentageChange: Number((((liveTick.price - lastTick.price) / lastTick.price) * 100).toFixed(2)),
                        volumeSpikeRatio: Number((liveTick.volume / avgVolume).toFixed(1)),
                        trigger: "📊 Raw Institutional Volume Spike"
                    });

                    await redisClient.setEx(cooldownKey, 60, "true");
                }
            }
        }

        await redisClient.lPush(memoryKey, JSON.stringify(liveTick));
        await redisClient.lTrim(memoryKey, 0, this.memoryLength - 1);
    }
}
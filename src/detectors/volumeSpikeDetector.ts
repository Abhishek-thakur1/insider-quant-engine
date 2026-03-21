import type { IDetector, TickData } from "../core/types.js";
import { sendTelegramAlert } from "../workers/telegramWorker.js";


export class VolumeSpikeDetector implements IDetector {
    public name = "Volume Squeeze & Spike";
    public symbol: string;

    private memoryLength: number;
    private tickHistory: TickData[] = [];
    private cooldown: boolean = false;

    constructor(symbol: string, memoryLength: number = 5) {
        this.symbol = symbol;
        this.memoryLength = memoryLength;
    }

    public analyze(liveTick: TickData) {
        if (this.tickHistory.length === this.memoryLength) {

            const volumes = this.tickHistory.map(t => t.volume);
            const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

            const lastTick = this.tickHistory.at(-1);
            if (!lastTick) return;

            const lastPrice = lastTick.price;

            const isVolumeSurge = liveTick.volume > (avgVolume * 4);
            const isBullish = liveTick.price > lastPrice;

            if (isVolumeSurge && isBullish && !this.cooldown) {
                console.log(`\n🌊 [VOLUME DETECTOR] Massive block buying in ${this.symbol}!`);

                sendTelegramAlert({
                    symbol: this.symbol,
                    price: liveTick.price,
                    percentageChange: Number((((liveTick.price - lastPrice) / lastPrice) * 100).toFixed(2)),
                    volumeSpikeRatio: Number((liveTick.volume / avgVolume).toFixed(1)),
                    trigger: "📊 Raw Institutional Volume Spike"
                });

                this.cooldown = true;
                setTimeout(() => { this.cooldown = false; }, 60000);

                return;
            }
        }

        this.tickHistory.push(liveTick);
        if (this.tickHistory.length > this.memoryLength) {
            this.tickHistory.shift();
        }
    }
}
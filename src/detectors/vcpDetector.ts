import type { IDetector } from '../core/types.js';
import { sendTelegramAlert } from '../workers/telegramWorker.js';

export class VcpDetector implements IDetector {
    public name: string = "VCP Breakout";
    public symbol: string;
    private memoryLength: number;
    private tickHistory: { price: number; volume: number }[] = [];
    private isArmed: boolean = false;

    constructor(symbol: string, memoryLength: number = 10) {
        this.symbol = symbol;
        this.memoryLength = memoryLength;
    }

    public analyze(liveTick: { price: number; volume: number }) {
        if (this.tickHistory.length === this.memoryLength) {
            const prices = this.tickHistory.map(t => t.price);
            const volumes = this.tickHistory.map(t => t.volume);

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
                    this.tickHistory = [];
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

        this.tickHistory.push(liveTick);
        if (this.tickHistory.length > this.memoryLength) {
            this.tickHistory.shift();
        }
    }
}
import { sendTelegramAlert } from "../workers/telegramWorker.js";
import type { IDetector, TickData } from "../core/types.js";
import { redisClient } from "../config/redis.js";
import { getVwap, getMarketBias } from "../utils/vwapUtils.js";

const BASELINE_MEMORY_LENGTH = 150;
const VOLUME_SPIKE_MULTIPLIER = 12;
const MIN_BLOCK_VALUE = 20_000_000; // ₹2Cr minimum block — filters mid-cap noise
const COOLDOWN_SECONDS = 900;       // 15 min lockout per symbol
// ─────────────────────────────────────────────────────────────────────────────

// Opening 30 min has structurally abnormal volume that would spam alerts constantly.
const getISTMinutes = (): number => {
    const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
    const d = new Date(istMs);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const isMarketHours = (): boolean => {
    const m = getISTMinutes();
    return m >= 9 * 60 + 30 && m <= 15 * 60;
};

export class VolumeSpikeDetector implements IDetector {
    public name: string = "Institutional Volume Absorption";
    public symbol: string;

    constructor(symbol: string) {
        this.symbol = symbol;
    }

    public async analyze(liveTick: TickData): Promise<void> {
        if (!isMarketHours()) return;

        const memoryKey = `memory:volume:${this.symbol}`;
        const cooldownKey = `cooldown:volume:${this.symbol}`;

        const isCoolingDown = await redisClient.get(cooldownKey);
        if (isCoolingDown) {
            await redisClient
                .multi()
                .lPush(memoryKey, JSON.stringify(liveTick))
                .lTrim(memoryKey, 0, BASELINE_MEMORY_LENGTH - 1)
                .exec();
            return;
        }

        const rawMemory = await redisClient.lRange(memoryKey, 0, -1);
        const tickHistory: TickData[] = rawMemory.map(
            (item) => JSON.parse(item) as TickData,
        );

        if (tickHistory.length >= BASELINE_MEMORY_LENGTH) {
            const volumes = tickHistory.map((t) => t.volume);
            const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
            const avgPrice =
                tickHistory.reduce((a, t) => a + t.price, 0) / tickHistory.length;

            // ── FILTER 1: Institutional block value floor ─────────────────

            // This is the single most important filter for reducing noise.
            const blockValue = liveTick.price * liveTick.volume;
            const isInstitutionalSz = blockValue >= MIN_BLOCK_VALUE;

            // ── FILTER 2: Volume surge ────────────────────────────────────
            //  6× the 100-tick rolling baseline
            const isVolumeSurge =
                liveTick.volume > avgVolume * VOLUME_SPIKE_MULTIPLIER;

            // ── FILTER 3: Price above VWAP ────────────────────────────────

            const vwap = await getVwap(this.symbol);
            //   const isAboveVwap = vwap !== null ? liveTick.price > vwap : true;
            const isAboveVwap = vwap !== null ? liveTick.price > vwap : null;
            const isPriceLeadingUp = liveTick.price > avgPrice;
            const isPriceLeadingDown = liveTick.price < avgPrice;
            const isPriceMoving = Math.abs((liveTick.price - avgPrice) / avgPrice) * 100 >= 0.4; // 0.15% was random tick noise


            // ── FILTER 4: Market regime ───────────────────────────────────
            const marketBias = await getMarketBias();
            const isBullishMkt = marketBias !== "bearish";

            // ── LONG SIDE ────────────────────────────────────────────────
            // Price above VWAP + price leading up + bullish or neutral Nifty
            if (
                isInstitutionalSz &&
                isVolumeSurge &&
                isAboveVwap === true &&
                isPriceLeadingUp &&
                isPriceMoving &&
                marketBias !== 'bearish'
            ) {
                console.log(`\n🟢 [LONG SIGNAL] ${this.symbol} — Institutional Buying`);

                sendTelegramAlert({
                    symbol: this.symbol,
                    price: liveTick.price,
                    side: 'LONG',                                          // [ADD]
                    percentageChange: Number((((liveTick.price - avgPrice) / avgPrice) * 100).toFixed(2)),
                    volumeSpikeRatio: Number((liveTick.volume / avgVolume).toFixed(1)),
                    trigger: `🏛️ Block ₹${(blockValue / 100_000).toFixed(1)}L | ${(liveTick.volume / avgVolume).toFixed(1)}× surge | VWAP ₹${vwap?.toFixed(2)}`,
                    vwap: vwap ?? liveTick.price,
                    avgPrice,
                });

                await redisClient.multi()
                    .setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
                    .lPush(memoryKey, JSON.stringify(liveTick))
                    .lTrim(memoryKey, 0, BASELINE_MEMORY_LENGTH - 1)
                    .exec();
                return;
            }

            // ── SHORT SIDE ───────────────────────────────────────────────
            // Price below VWAP + price leading down + bearish or neutral Nifty
            if (
                isInstitutionalSz &&
                isVolumeSurge &&
                isAboveVwap === false &&
                isPriceLeadingDown &&
                isPriceMoving &&
                marketBias !== 'bullish'
            ) {
                console.log(`\n🔴 [SHORT SIGNAL] ${this.symbol} — Institutional Selling`);

                sendTelegramAlert({
                    symbol: this.symbol,
                    price: liveTick.price,
                    side: 'SHORT',                                         // [ADD]
                    percentageChange: Number((((liveTick.price - avgPrice) / avgPrice) * 100).toFixed(2)),
                    volumeSpikeRatio: Number((liveTick.volume / avgVolume).toFixed(1)),
                    trigger: `🏛️ Block ₹${(blockValue / 100_000).toFixed(1)}L | ${(liveTick.volume / avgVolume).toFixed(1)}× dump | VWAP ₹${vwap?.toFixed(2)}`,
                    vwap: vwap ?? liveTick.price,
                    avgPrice,
                });

                await redisClient.multi()
                    .setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
                    .lPush(memoryKey, JSON.stringify(liveTick))
                    .lTrim(memoryKey, 0, BASELINE_MEMORY_LENGTH - 1)
                    .exec();
                return;
            }

            //   if (isInstitutionalSz && isVolumeSurge && isAboveVwap && isBullishMkt) {
            //     // ── FILTER 5: Price must be LEADING, not lagging ──────────
            //     // A spike where price is BELOW rolling avg = selling into liquidity.
            //     // We only want spikes where price is ABOVE where it's been trading.
            //     // Example: stock drifts at ₹450 avg, spike hits at ₹453 → alert.
            //     //          stock drifts at ₹450 avg, spike hits at ₹447 → distribution, skip.
            //     const isPriceLeading = liveTick.price > avgPrice;

            //     if (isPriceLeading) {
            //       console.log(
            //         `\n🏛️  [BLOCK TRADE] ${this.symbol} — Institutional Absorption Confirmed`,
            //       );
            //       console.log(
            //         `   Block: ₹${(blockValue / 100_000).toFixed(1)}L | ${liveTick.volume.toLocaleString()} shares @ ₹${liveTick.price}`,
            //       );
            //       console.log(
            //         `   Volume: ${liveTick.volume.toLocaleString()} = ${(liveTick.volume / avgVolume).toFixed(1)}× 100-tick baseline`,
            //       );
            //       console.log(
            //         `   Price vs Avg: ₹${liveTick.price} vs ₹${avgPrice.toFixed(2)} rolling avg ← Leading ✅`,
            //       );
            //       console.log(
            //         `   VWAP: ₹${vwap?.toFixed(2) ?? "n/a"} | Nifty: ${marketBias}`,
            //       );

            //       sendTelegramAlert({
            //         symbol: this.symbol,
            //         price: liveTick.price,
            //         // % change vs rolling avg price, not single previous tick
            //         percentageChange: Number(
            //           (((liveTick.price - avgPrice) / avgPrice) * 100).toFixed(2),
            //         ),
            //         volumeSpikeRatio: Number((liveTick.volume / avgVolume).toFixed(1)),
            //         // Full context in trigger string — actionable without opening charts
            //         trigger: `🏛️ Block ₹${(blockValue / 100_000).toFixed(1)}L | ${(liveTick.volume / avgVolume).toFixed(1)}× surge | ${vwap ? `VWAP ₹${vwap.toFixed(2)}` : ""} | Nifty ${marketBias}`,
            //       });

            //       // Pipeline: set cooldown AND write baseline in one round trip
            //       await redisClient
            //         .multi()
            //         .setEx(cooldownKey, COOLDOWN_SECONDS, "true")
            //         .lPush(memoryKey, JSON.stringify(liveTick))
            //         .lTrim(memoryKey, 0, BASELINE_MEMORY_LENGTH - 1)
            //         .exec();
            //       return;
            //     }
            //   }
        }

        // Pipeline write — was 2 sequential calls = 2 round trips
        await redisClient
            .multi()
            .lPush(memoryKey, JSON.stringify(liveTick))
            .lTrim(memoryKey, 0, BASELINE_MEMORY_LENGTH - 1)
            .exec();
    }
}
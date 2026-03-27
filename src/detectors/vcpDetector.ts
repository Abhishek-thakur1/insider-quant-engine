import { sendTelegramAlert } from "../workers/telegramWorker.js";
import type { IDetector, TickData } from "../core/types.js";
import { redisClient } from "../config/redis.js";
import { getVwap, getMarketBias } from "../utils/vwapUtils.js";

const BOX_MEMORY_LENGTH = 20; // ticks to define the consolidation box
const BASELINE_MEMORY_LENGTH = 100; // ticks for long-term volume reference (~15 min on avg stock)
const MIN_CONSOLIDATION_MS = 5 * 60 * 1000; // box must be at least 5 minutes old
const MAX_SPREAD_PCT = 0.5; // box price range must be < 0.5%
const VOLUME_CONTRACTION_RATIO = 0.7; // box avg vol must be < 70% of baseline to confirm contraction
const BREAKOUT_VOL_MULTIPLIER = 5; // breakout tick must be > 5× baseline avg vol
const BREAKOUT_PRICE_BUFFER = 1.001; // price must exceed boxHigh by 0.1% to confirm break
const FAILURE_PRICE_BUFFER = 0.999; // price below boxLow × 0.999 = pattern failed
const COOLDOWN_SECONDS = 1800; // 30 min between alerts for same symbol
const MIN_BLOCK_VALUE = 5_000_000;

const getISTMinutes = (): number => {
    const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
    const d = new Date(istMs);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const isMarketHours = (): boolean => {
    const m = getISTMinutes();
    return m >= 9 * 60 + 30 && m <= 15 * 60;
};

export class VcpDetector implements IDetector {
    public name: string = "VCP Institutional Breakout";
    public symbol: string;

    private isArmed: boolean = false;

    constructor(symbol: string) {
        this.symbol = symbol;
    }

    public async analyze(liveTick: TickData): Promise<void> {
        if (!isMarketHours()) return;

        const boxKey = `memory:vcp:${this.symbol}`;
        const baselineKey = `baseline:vcp:${this.symbol}`;
        const cooldownKey = `cooldown:vcp:${this.symbol}`;

        const isCoolingDown = await redisClient.get(cooldownKey);
        if (isCoolingDown) {
            await redisClient
                .multi()
                .lPush(baselineKey, JSON.stringify(liveTick))
                .lTrim(baselineKey, 0, BASELINE_MEMORY_LENGTH - 1)
                .exec();
            return;
        }

        const [rawBox, rawBaseline] = await Promise.all([
            redisClient.lRange(boxKey, 0, -1),
            redisClient.lRange(baselineKey, 0, -1),
        ]);

        const boxHistory: TickData[] = rawBox.map(
            (item) => JSON.parse(item) as TickData,
        );
        const baselineHistory: TickData[] = rawBaseline.map(
            (item) => JSON.parse(item) as TickData,
        );

        if (
            boxHistory.length >= BOX_MEMORY_LENGTH &&
            baselineHistory.length >= BASELINE_MEMORY_LENGTH
        ) {
            const prices = boxHistory.map((t) => t.price);
            const boxVolumes = boxHistory.map((t) => t.volume);
            const baselineVols = baselineHistory.map((t) => t.volume);

            const boxHigh = Math.max(...prices);
            const boxLow = Math.min(...prices);
            const spreadPercent = ((boxHigh - boxLow) / boxLow) * 100;
            const boxAvgVol =
                boxVolumes.reduce((a, b) => a + b, 0) / boxVolumes.length;
            const baselineAvgVol =
                baselineVols.reduce((a, b) => a + b, 0) / baselineVols.length;

            const oldestBoxTick = boxHistory[boxHistory.length - 1];
            const consolidationAge =
                Date.now() - (oldestBoxTick?.timestamp ?? Date.now());
            const isOldEnough = consolidationAge >= MIN_CONSOLIDATION_MS;

            const isVolumeContracting =
                boxAvgVol < baselineAvgVol * VOLUME_CONTRACTION_RATIO;

            // ── ARMED STATE: Watch for the breakout ─────────────────────────
            if (this.isArmed) {
                const isBreakingResistance =
                    liveTick.price > boxHigh * BREAKOUT_PRICE_BUFFER;

                // Box volume is suppressed by design — using it as denominator inflates the ratio
                const isVolumeExplosion =
                    liveTick.volume > baselineAvgVol * BREAKOUT_VOL_MULTIPLIER;
                const blockValue = liveTick.price * liveTick.volume;
                const isInstitutionalSz = blockValue >= MIN_BLOCK_VALUE;

                const vwap = await getVwap(this.symbol);
                const isAboveVwap = vwap !== null ? liveTick.price > vwap : true;

                const marketBias = await getMarketBias();
                const isBullishMkt = marketBias !== "bearish";

                if (
                    isBreakingResistance &&
                    isVolumeExplosion &&
                    isAboveVwap &&
                    isBullishMkt &&
                    isInstitutionalSz
                ) {
                    console.log(
                        `\n🏛️  [INSTITUTIONAL VCP] ${this.symbol} — Breakout CONFIRMED`,
                    );
                    console.log(
                        `   Box: ₹${boxLow.toFixed(2)} – ₹${boxHigh.toFixed(2)} | Spread: ${spreadPercent.toFixed(2)}%`,
                    );
                    console.log(
                        `   Age: ${(consolidationAge / 60000).toFixed(1)} min | VWAP: ₹${vwap?.toFixed(2) ?? "n/a"}`,
                    );
                    console.log(
                        `   Vol Contraction: ${((boxAvgVol / baselineAvgVol) * 100).toFixed(0)}% of baseline ✅`,
                    );
                    console.log(
                        `   Breakout vol: ${liveTick.volume.toLocaleString()} = ${(liveTick.volume / baselineAvgVol).toFixed(1)}× baseline ✅`,
                    );

                    sendTelegramAlert({
                        symbol: this.symbol,
                        price: liveTick.price,
                        side: 'LONG',

                        percentageChange: Number(
                            (((liveTick.price - boxLow) / boxLow) * 100).toFixed(2),
                        ),
                        volumeSpikeRatio: Number(
                            (liveTick.volume / baselineAvgVol).toFixed(1),
                        ),
                        trigger: `📦 VCP | Box ${(consolidationAge / 60000).toFixed(1)}min | Vol ${((boxAvgVol / baselineAvgVol) * 100).toFixed(0)}% contracted | ${(liveTick.volume / baselineAvgVol).toFixed(1)}× burst | ${vwap ? `VWAP ₹${vwap.toFixed(2)}` : ""}`,
                        vwap: vwap ?? liveTick.price,
                        avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
                    });



                    this.isArmed = false;

                    await redisClient
                        .multi()
                        .del(boxKey)
                        .setEx(cooldownKey, COOLDOWN_SECONDS, "true")
                        .exec();
                    return;
                }

                const isBreakingSupport = liveTick.price < boxLow * 0.999;
                const isBreakdownVolume = liveTick.volume > (baselineAvgVol * BREAKOUT_VOL_MULTIPLIER);
                const isBelowVwap = vwap !== null ? liveTick.price < vwap : false;
                const isBearishMkt = marketBias !== 'bullish';

                if (isBreakingSupport && isBreakdownVolume && isBelowVwap && isBearishMkt) {
                    console.log(`\n🔴 [VCP BREAKDOWN] ${this.symbol} — Institutional Flush`);

                    sendTelegramAlert({
                        symbol: this.symbol,
                        price: liveTick.price,
                        side: 'SHORT',
                        percentageChange: Number((((liveTick.price - boxHigh) / boxHigh) * 100).toFixed(2)),
                        volumeSpikeRatio: Number((liveTick.volume / baselineAvgVol).toFixed(1)),
                        trigger: `📦 VCP Breakdown | Box ${(consolidationAge / 60000).toFixed(1)}min | ${(liveTick.volume / baselineAvgVol).toFixed(1)}× flush | VWAP ₹${vwap?.toFixed(2)}`,
                        vwap: vwap ?? liveTick.price,
                        avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
                    });

                    this.isArmed = false;
                    await redisClient.multi()
                        .del(boxKey)
                        .setEx(cooldownKey, COOLDOWN_SECONDS, 'true')
                        .exec();
                    return;
                }

                // If price breaks below box support, the setup has failed. Clear and reset.
                if (liveTick.price < boxLow * FAILURE_PRICE_BUFFER) {
                    this.isArmed = false;
                    console.log(
                        `\n❌ [VCP] ${this.symbol} — Pattern FAILED. Price broke below box. Clearing.`,
                    );
                    await redisClient.del(boxKey);
                    // Fall through to write new tick to fresh box
                }
            }

            // ── DISARMED STATE: Scan for arm condition ───────────────────────
            // Now requires ALL THREE: tight spread + time + volume contraction
            if (!this.isArmed) {
                if (
                    spreadPercent < MAX_SPREAD_PCT &&
                    isOldEnough &&
                    isVolumeContracting
                ) {
                    this.isArmed = true;
                    console.log(`\n🔒 [VCP] ${this.symbol} — COILED & ARMED`);
                    console.log(
                        `   Spread: ${spreadPercent.toFixed(2)}% | Age: ${(consolidationAge / 60000).toFixed(1)}min`,
                    );
                    console.log(
                        `   Vol: ${boxAvgVol.toFixed(0)} avg = ${((boxAvgVol / baselineAvgVol) * 100).toFixed(0)}% of baseline ← Contracting ✅`,
                    );
                } else if (spreadPercent >= MAX_SPREAD_PCT && this.isArmed) {
                    this.isArmed = false;
                    console.log(`\n🔓 [VCP] ${this.symbol} — Spread widened. Disarming.`);
                }
            }
        }

        await redisClient
            .multi()
            .lPush(boxKey, JSON.stringify(liveTick))
            .lTrim(boxKey, 0, BOX_MEMORY_LENGTH - 1)
            .lPush(baselineKey, JSON.stringify(liveTick))
            .lTrim(baselineKey, 0, BASELINE_MEMORY_LENGTH - 1)
            .exec();
    }
}
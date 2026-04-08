// ============================================================
//— Opening Range Breakout Detector
//
// Logic:
//   Builds TWO opening ranges simultaneously per symbol:
//     - 15-min range: 9:15 → 9:30
//     - 30-min range: 9:15 → 9:45
//   Fires on whichever breaks first with volume + VWAP confirmation.
//   Once one fires, the other is discarded (cooldown kicks in).
//
// Why ORB works:
//   The opening range captures the initial price discovery battle
//   between bulls and bears. A breakout with volume means one side
//   has decisively won. Institutions front-load orders at open —
//   the range is their footprint.
// ============================================================

import { sendTelegramAlert } from '../workers/telegramWorker.js';
import type { IDetector, TickData } from '../core/types.js';
import { redisClient } from '../config/redis.js';
import { getVwap, getMarketBias } from '../utils/vwapUtils.js';

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const RANGE_15_END_MIN = 9 * 60 + 30;   // 9:30 AM IST
const RANGE_30_END_MIN = 9 * 60 + 45;   // 9:45 AM IST
const TRADE_START_MIN = 9 * 60 + 30;   // no alerts before 9:30
const TRADE_END_MIN = 14 * 60 + 30;  // no new entries after 2:30 PM
const BREAKOUT_BUFFER = 1.002;          // price must exceed range by 0.2% to confirm
const BREAKDOWN_BUFFER = 0.998;          // price must break below range by 0.2%
const MIN_RANGE_PCT = 0.2;            // ignore symbols with range < 0.2% (too tight)
const MAX_RANGE_PCT = 3.0;            // ignore symbols with range > 3% (too wild)
const VOL_MULTIPLIER = 3;              // breakout tick must be > 3× baseline avg vol
const MIN_BLOCK_VALUE = 5_000_000;      // ₹50L minimum block
const COOLDOWN_SECONDS = 1800;           // 30 min between alerts per symbol
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};

interface OrbRange {
    high: number;
    low: number;
    volumes: number[];   // tick volumes during range — used as baseline
    fired: boolean;
}

export class OrbDetector implements IDetector {
    public name = 'ORB Breakout';
    public symbol: string;

    // Both ranges built simultaneously in memory
    private range15: OrbRange | null = null;
    private range30: OrbRange | null = null;

    // Track whether ranges are still being built
    private range15Locked = false;  // true once 9:30 passes
    private range30Locked = false;  // true once 9:45 passes

    constructor(symbol: string) {
        this.symbol = symbol;
    }

    public async analyze(liveTick: TickData): Promise<void> {
        const m = getISTMinutes();

        // ── : Build opening ranges (9:15 → 9:45) ─────────────────
        if (m >= 9 * 60 + 15 && m < RANGE_30_END_MIN) {

            // Build 15-min range until 9:30
            if (m < RANGE_15_END_MIN) {
                if (!this.range15) {
                    this.range15 = { high: liveTick.price, low: liveTick.price, volumes: [], fired: false };
                } else {
                    this.range15.high = Math.max(this.range15.high, liveTick.price);
                    this.range15.low = Math.min(this.range15.low, liveTick.price);
                }
                this.range15.volumes.push(liveTick.volume);
            }

            // Build 30-min range until 9:45
            if (!this.range30) {
                this.range30 = { high: liveTick.price, low: liveTick.price, volumes: [], fired: false };
            } else {
                this.range30.high = Math.max(this.range30.high, liveTick.price);
                this.range30.low = Math.min(this.range30.low, liveTick.price);
            }
            this.range30.volumes.push(liveTick.volume);

            return;
        }

        // ── Lock ranges once their windows close ──────────────────────────
        if (m >= RANGE_15_END_MIN && !this.range15Locked) {
            this.range15Locked = true;
        }
        if (m >= RANGE_30_END_MIN && !this.range30Locked) {
            this.range30Locked = true;
        }

        // ── : Watch for breakouts ──────────────────────────────────
        if (m < TRADE_START_MIN || m > TRADE_END_MIN) return;
        if (!this.range15Locked && !this.range30Locked) return;

        const cooldownKey = `cooldown:orb:${this.symbol}`;
        const isCoolingDown = await redisClient.get(cooldownKey);
        if (isCoolingDown) return;

        const vwap = await getVwap(this.symbol);
        const marketBias = await getMarketBias();
        const blockValue = liveTick.price * liveTick.volume;
        const isBlockSized = blockValue >= MIN_BLOCK_VALUE;

        // Try 15-min range first (tighter = higher probability)
        // Fall back to 30-min range if 15-min hasn't fired
        const ranges: Array<{ range: OrbRange; label: string }> = [];
        if (this.range15 && this.range15Locked && !this.range15.fired) {
            ranges.push({ range: this.range15, label: '15min ORB' });
        }
        if (this.range30 && this.range30Locked && !this.range30.fired) {
            ranges.push({ range: this.range30, label: '30min ORB' });
        }

        for (const { range, label } of ranges) {
            const rangePct = ((range.high - range.low) / range.low) * 100;

            // Skip ranges that are too tight or too wild
            if (rangePct < MIN_RANGE_PCT || rangePct > MAX_RANGE_PCT) continue;

            const avgVol = range.volumes.length > 0
                ? range.volumes.reduce((a, b) => a + b, 0) / range.volumes.length
                : 0;
            const isVolumeConfirmed = avgVol > 0 && liveTick.volume > avgVol * VOL_MULTIPLIER;

            const rangeSize = range.high - range.low;
            const risk = rangeSize; // SL = full range size

            // ── LONG: Break above range high ─────────────────────────────
            if (
                liveTick.price > range.high * BREAKOUT_BUFFER &&
                isVolumeConfirmed &&
                isBlockSized &&
                (vwap !== null ? liveTick.price > vwap : true) &&
                marketBias !== 'bearish'
            ) {
                const entry = liveTick.price;
                const sl = Number((range.low).toFixed(2));           // SL below range low
                const target1 = Number((entry + risk * 1.5).toFixed(2));
                const target2 = Number((entry + risk * 2.5).toFixed(2));

                console.log(`\n📈 [ORB LONG] ${this.symbol} — ${label} Breakout`);
                console.log(`   Range: ₹${range.low.toFixed(2)}–₹${range.high.toFixed(2)} (${rangePct.toFixed(2)}%)`);
                console.log(`   Entry: ₹${entry} | SL: ₹${sl} | T1: ₹${target1} | T2: ₹${target2}`);

                sendTelegramAlert({
                    symbol: this.symbol,
                    price: entry,
                    side: 'LONG',
                    percentageChange: Number((((entry - range.low) / range.low) * 100).toFixed(2)),
                    volumeSpikeRatio: Number((liveTick.volume / avgVol).toFixed(1)),
                    trigger: `📊 ${label} | Range ₹${range.low.toFixed(2)}–₹${range.high.toFixed(2)} (${rangePct.toFixed(2)}%) | ${(liveTick.volume / avgVol).toFixed(1)}× vol | VWAP ₹${vwap?.toFixed(2)}`,
                    vwap: vwap ?? entry,
                    avgPrice: (range.high + range.low) / 2,
                });

                range.fired = true;
                await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
                return;
            }

            // ── SHORT: Break below range low ──────────────────────────────
            if (
                liveTick.price < range.low * BREAKDOWN_BUFFER &&
                isVolumeConfirmed &&
                isBlockSized &&
                (vwap !== null ? liveTick.price < vwap : true) &&
                marketBias !== 'bullish'
            ) {
                const entry = liveTick.price;
                const sl = Number((range.high).toFixed(2));          // SL above range high
                const target1 = Number((entry - risk * 1.5).toFixed(2));
                const target2 = Number((entry - risk * 2.5).toFixed(2));

                console.log(`\n📉 [ORB SHORT] ${this.symbol} — ${label} Breakdown`);
                console.log(`   Range: ₹${range.low.toFixed(2)}–₹${range.high.toFixed(2)} (${rangePct.toFixed(2)}%)`);
                console.log(`   Entry: ₹${entry} | SL: ₹${sl} | T1: ₹${target1} | T2: ₹${target2}`);

                sendTelegramAlert({
                    symbol: this.symbol,
                    price: entry,
                    side: 'SHORT',
                    percentageChange: Number((((entry - range.high) / range.high) * 100).toFixed(2)),
                    volumeSpikeRatio: Number((liveTick.volume / avgVol).toFixed(1)),
                    trigger: `📊 ${label} | Range ₹${range.low.toFixed(2)}–₹${range.high.toFixed(2)} (${rangePct.toFixed(2)}%) | ${(liveTick.volume / avgVol).toFixed(1)}× vol | VWAP ₹${vwap?.toFixed(2)}`,
                    vwap: vwap ?? entry,
                    avgPrice: (range.high + range.low) / 2,
                });

                range.fired = true;
                await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, 'true');
                return;
            }
        }

        return;
    }
}
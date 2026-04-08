import { sendTelegramAlert } from "../workers/telegramWorker.js";
import type { IDetector, TickData } from "../core/types.js";
import { redisClient } from "../config/redis.js";
import { getVwap } from "../utils/vwapUtils.js";
import { getBestStrike } from "../utils/optionUtils.js";

// ─── TUNABLE CONSTANTS ───────────────────────────────────────
const CANDLE_DURATION_MS = 3 * 60 * 1000; // 3-minute candles to filter out 1-min noise
const EMA_PERIOD = 21; // Institutional trend baseline
const COOLDOWN_SECONDS = 7200; // 2 Hour Cooldown (Guarantees max 2-3 trades a day)
const MAX_RISK_POINTS = 25; // Reject if Stop Loss is wider than 25 index points
// ─────────────────────────────────────────────────────────────

const getISTMinutes = (): number => {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

// Ignore first 45 minutes of the day to let the trend and VWAP establish
const isActiveWindow = (): boolean => {
  const m = getISTMinutes();
  return m >= 9 * 60 + 45 && m <= 15 * 60;
};

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  startTs: number;
}

export class ValueZoneScalpDetector implements IDetector {
  public name = "Value Zone Trend Ride";
  public symbol = "NSE:NIFTY50-INDEX";

  private currentCandle: Candle | null = null;
  private history: Candle[] = [];

  // Helper to calculate EMA from our rolling history
  private calculateEMA(data: number[], period: number): number | null {
    if (data.length < period) return null;
    const k = 2 / (period + 1);

    // Seed the EMA with an SMA of the first 'period' elements
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // Calculate EMA for the rest
    for (let i = period; i < data.length; i++) {
      ema = data[i]! * k + ema * (1 - k);
    }
    return ema;
  }

  public async analyze(liveTick: TickData): Promise<void> {
    if (!isActiveWindow() || this.symbol !== "NSE:NIFTY50-INDEX") return;

    const now = liveTick.timestamp;

    // ── 1. Build 3-Minute Candle ─────────────────────────────────────
    if (!this.currentCandle) {
      this.currentCandle = {
        open: liveTick.price,
        high: liveTick.price,
        low: liveTick.price,
        close: liveTick.price,
        volume: liveTick.volume,
        startTs: now,
      };
      return;
    }

    if (now - this.currentCandle.startTs < CANDLE_DURATION_MS) {
      this.currentCandle.high = Math.max(
        this.currentCandle.high,
        liveTick.price,
      );
      this.currentCandle.low = Math.min(this.currentCandle.low, liveTick.price);
      this.currentCandle.close = liveTick.price;
      this.currentCandle.volume += liveTick.volume;
      return;
    }

    // ── 2. Candle Closed ─────────────────────────────────────────────
    const c = { ...this.currentCandle };
    this.currentCandle = {
      open: liveTick.price,
      high: liveTick.price,
      low: liveTick.price,
      close: liveTick.price,
      volume: liveTick.volume,
      startTs: now,
    };

    this.history.push(c);
    // Keep enough history to calculate a stable 21 EMA + context
    if (this.history.length > EMA_PERIOD + 10) this.history.shift();

    // Engine must warm up to establish the 21 EMA
    if (this.history.length < EMA_PERIOD + 2) return;

    const cooldownKey = `cooldown:nifty_value_zone_scalp`;
    if (await redisClient.get(cooldownKey)) return;

    const vwap = await getVwap(this.symbol);
    if (!vwap) return;

    // Extract closing prices for EMA calculation
    const closes = this.history.map((h) => h.close);
    const currentEma = this.calculateEMA(closes, EMA_PERIOD);
    const prevEma = this.calculateEMA(closes.slice(0, -1), EMA_PERIOD);

    if (!currentEma || !prevEma) return;

    // ── 3. Volume Divergence Baseline ────────────────────────────────
    // Average volume of the prior 3 candles (the Impulse move)
    const prior3Vols = this.history.slice(-4, -1).map((h) => h.volume);
    const avgImpulseVol = prior3Vols.reduce((a, b) => a + b, 0) / 3;

    // ── LONG SETUP (CE) ──────────────────────────────────────────────
    // 1. Trend Filter: EMA is angled UP and is clearly ABOVE VWAP
    const isUptrend = currentEma > prevEma && currentEma > vwap;

    // 2. The Pullback: Wick touches the Value Zone (between EMA and VWAP)
    const touchedValueZoneLong = c.low <= currentEma && c.low >= vwap - 5;

    // 3. Rejection: Closed strong (green body) above the EMA
    const closedStrongLong = c.close > c.open && c.close > currentEma;

    // 4. Volume Exhaustion: Pullback volume must be LESS than impulse volume
    // We ignore volume if it's the Spot Index (which is a tick-count, not true volume)
    // Note: For true futures volume, you'd check: c.volume < avgImpulseVol

    if (isUptrend && touchedValueZoneLong && closedStrongLong) {
      const indexSl = Number(c.low.toFixed(2));
      const risk = c.close - indexSl;

      if (risk > MAX_RISK_POINTS || risk < 5) return; // Strict risk parameters

      const t1 = Number((c.close + risk * 1.5).toFixed(2));
      const best = getBestStrike("CE", c.close); // Returns ATM/ITM strike

      console.log(
        `\n🎯 [VALUE ZONE LONG] Nifty pulled back to 21 EMA. Entry confirmed at ₹${c.close}`,
      );

      sendTelegramAlert({
        symbol: `NIFTY ${best.strike} CE`,
        price: c.close,
        side: "LONG",
        percentageChange: 0,
        volumeSpikeRatio: 1,
        trigger: `🎯 Value Zone CE | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${c.close} | SL ₹${indexSl} | T1 ₹${t1} | ${best.reason}`,
        vwap,
        avgPrice: currentEma,
      });

      await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, "true");
      return;
    }

    // ── SHORT SETUP (PE) ─────────────────────────────────────────────
    // 1. Trend Filter: EMA is angled DOWN and is clearly BELOW VWAP
    const isDowntrend = currentEma < prevEma && currentEma < vwap;

    // 2. The Pullback: Wick touches the Value Zone (between EMA and VWAP)
    const touchedValueZoneShort = c.high >= currentEma && c.high <= vwap + 5;

    // 3. Rejection: Closed weak (red body) below the EMA
    const closedWeakShort = c.close < c.open && c.close < currentEma;

    if (isDowntrend && touchedValueZoneShort && closedWeakShort) {
      const indexSl = Number(c.high.toFixed(2));
      const risk = indexSl - c.close;

      if (risk > MAX_RISK_POINTS || risk < 5) return;

      const t1 = Number((c.close - risk * 1.5).toFixed(2));
      const best = getBestStrike("PE", c.close);

      console.log(
        `\n🎯 [VALUE ZONE SHORT] Nifty pulled back to 21 EMA. Entry confirmed at ₹${c.close}`,
      );

      sendTelegramAlert({
        symbol: `NIFTY ${best.strike} PE`,
        price: c.close,
        side: "SHORT",
        percentageChange: 0,
        volumeSpikeRatio: 1,
        trigger: `🎯 Value Zone PE | Strike ${best.strike} | Prem ~₹${best.ltp} | Index ₹${c.close} | SL ₹${indexSl} | T1 ₹${t1} | ${best.reason}`,
        vwap,
        avgPrice: currentEma,
      });

      await redisClient.setEx(cooldownKey, COOLDOWN_SECONDS, "true");
      return;
    }
  }
}

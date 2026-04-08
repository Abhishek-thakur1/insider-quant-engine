import { sendTelegramAlert } from "../workers/telegramWorker.js";
import type { IDetector, TickData } from "../core/types.js";
import { redisClient } from "../config/redis.js";
import { getVwap } from "../utils/vwapUtils.js";
import { getBestStrike } from "../utils/optionUtils.js";

export class LiquiditySweepDetector implements IDetector {
  public name = "Institutional Liquidity Sniper";
  public symbol = "NSE:NIFTY50-INDEX";

  private morningHigh: number = 0;
  private morningLow: number = 0;
  private state: "WAITING" | "SWEPT_HIGH" | "SWEPT_LOW" = "WAITING";

  public async analyze(liveTick: TickData): Promise<void> {
    const price = liveTick.price;
    const now = new Date(liveTick.timestamp + 5.5 * 60 * 60 * 1000);
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    // 1. Fetch Morning Range (9:15 - 9:30) levels from Redis
    // Your ORB detector already stores these, we just consume them
    if (minutes >= 9 * 60 + 31 && this.morningHigh === 0) {
      const high = await redisClient.get(`orb:15min:high:${this.symbol}`);
      const low = await redisClient.get(`orb:15min:low:${this.symbol}`);

      if (high && low) {
        this.morningHigh = parseFloat(high);
        this.morningLow = parseFloat(low);
        console.log(
          `[Liquidity Sniper] 🎯 Levels Locked: H:${this.morningHigh} L:${this.morningLow}`,
        );
      }
      return;
    }

    if (this.morningHigh === 0 || minutes > 15 * 60 + 15) return;

    const cooldownKey = `cooldown:liquidity_sweep:${this.symbol}`;
    if (await redisClient.get(cooldownKey)) return;

    // 2. State Machine: Detection Logic
    // We look for a "Poke" outside the range followed by a sharp reversal
    if (this.state === "WAITING") {
      if (price > this.morningHigh + 2) this.state = "SWEPT_HIGH";
      if (price < this.morningLow - 2) this.state = "SWEPT_LOW";
    }

    // 3. The Trap Spring (Market Structure Shift)
    // If price swept HIGH then crashes back BELOW the high = Short
    if (this.state === "SWEPT_HIGH" && price < this.morningHigh - 3) {
      await this.executeSignal(
        "SHORT",
        price,
        "🐻 Bull Trap (Liquidity Sweep High)",
      );
    }

    // If price swept LOW then surges back ABOVE the low = Long
    if (this.state === "SWEPT_LOW" && price > this.morningLow + 3) {
      await this.executeSignal(
        "LONG",
        price,
        "🚀 Bear Trap (Liquidity Sweep Low)",
      );
    }
  }

  private async executeSignal(
    side: "LONG" | "SHORT",
    price: number,
    trigger: string,
  ) {
    const vwap = (await getVwap(this.symbol)) || price;
    const best = getBestStrike(side === "LONG" ? "CE" : "PE", price);

    await sendTelegramAlert({
      symbol: isOption(this.symbol)
        ? this.symbol
        : `NIFTY ${best.strike} ${side === "LONG" ? "CE" : "PE"}`,
      price,
      side,
      percentageChange: 0,
      volumeSpikeRatio: 1.5,
      trigger: `${trigger} | Entry ₹${price} | Target 1:2 RR | SL: Sweep High/Low`,
      vwap,
      avgPrice: price,
    });

    const cooldownKey = `cooldown:liquidity_sweep:${this.symbol}`;
    await redisClient.setEx(cooldownKey, 3600, "true"); // 60-minute cooldown
    this.state = "WAITING";
  }
}

// Helper to check if it's already an option symbol
function isOption(sym: string) {
  return sym.includes("CE") || sym.includes("PE");
}

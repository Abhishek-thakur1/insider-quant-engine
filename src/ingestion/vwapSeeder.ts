import fyersApi from "fyers-api-v3";
import fs from "fs";
import path from "path";
import { ENV } from "../config/env.js";
import { redisClient } from "../config/redis.js";
import type { VwapState } from "../core/types.js";

const TOKEN_PATH = path.resolve('/app/token', "access_token.txt");
const WATCHLIST_PATH = path.resolve(process.cwd(), "watchlist.json");

// Helper to get today's date in YYYY-MM-DD format for the Fyers API
const getTodayString = (): string => {
  const istDate = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return istDate.toISOString().split("T")[0]!;
};

export const seedHistoricalVwap = async (): Promise<void> => {
  console.log("\n[Seeder] 🌱 Initiating Historical VWAP Sync...");

  if (!fs.existsSync(TOKEN_PATH) || !fs.existsSync(WATCHLIST_PATH)) {
    console.error("[Seeder] ❌ Missing auth files. Cannot seed VWAP.");
    return;
  }

  const accessToken = fs.readFileSync(TOKEN_PATH, "utf8").trim();
  const watchlist: string[] = JSON.parse(
    fs.readFileSync(WATCHLIST_PATH, "utf8"),
  );
  const activeUniverse = watchlist.slice(0, 50);

  // Fyers API requires AppId and Token to be set globally for REST calls
  fyersApi.setAppId(ENV.FYERS_APP_ID);
  fyersApi.setAccessToken(accessToken);

  const todayStr = getTodayString();
  let successCount = 0;

  console.log(
    `[Seeder] 📥 Downloading intraday data for ${activeUniverse.length} equities...`,
  );

  // We process in small batches to avoid Fyers API rate limits
  for (const symbol of activeUniverse) {
    try {
      const response = await fyersApi.fyersHistory({
        symbol: symbol,
        resolution: "1",
        date_format: "1",
        range_from: todayStr,
        range_to: todayStr,
        cont_flag: "1",
      });

      if (
        response.s === "ok" &&
        response.candles &&
        response.candles.length > 0
      ) {
        let cumulativePV = 0;
        let cumulativeVol = 0;

        // Fyers Candle Format: [epoch_time, open, high, low, close, volume]
        for (const candle of response.candles) {
          const closePrice = candle[4];
          const volume = candle[5];

          cumulativePV += closePrice * volume;
          cumulativeVol += volume;
        }

        if (cumulativeVol > 0) {
          const finalVwap = cumulativePV / cumulativeVol;
          const state: VwapState = {
            cumulativePV,
            cumulativeVol,
            vwap: finalVwap,
          };

          // Must match the date-stamped key format from vwapUtils.ts
          const key = `vwap:${symbol}:${todayStr}`;
          await redisClient.set(key, JSON.stringify(state));
          successCount++;
        }
      }
    } catch (error) {
      console.error(`[Seeder] ⚠️ Failed to fetch history for ${symbol}`);
    }

    // 100ms delay between requests to respect Fyers API rate limits
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(
    `[Seeder] ✅ VWAP Sync Complete. ${successCount}/${activeUniverse.length} equities seeded.\n`,
  );
};

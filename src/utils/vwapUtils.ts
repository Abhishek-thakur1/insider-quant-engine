

import { redisClient } from "../config/redis.js";
import type { MarketBias, VwapState } from "../core/types.js";

const NIFTY_BIAS_KEY = "market:nifty:bias";

// 
// Called once per live tick in websocket.ts BEFORE strategies run.
// Uses the standard cumulative VWAP formula: Σ(P×V) / Σ(V)
// NOTE: Resets to 0 on engine restart — seed from DB once TimescaleDB is added.
export const updateVwap = async (
  symbol: string,
  price: number,
  volume: number,
): Promise<number> => {
  const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const key = `vwap:${symbol}:${todayIST}`;
  const raw = await redisClient.get(key);

  let state: VwapState = raw
    ? (JSON.parse(raw) as VwapState)
    : { cumulativePV: 0, cumulativeVol: 0, vwap: price };

  state.cumulativePV += price * volume;
  state.cumulativeVol += volume;
  state.vwap =
    state.cumulativeVol > 0 ? state.cumulativePV / state.cumulativeVol : price;

  await redisClient.set(key, JSON.stringify(state));
  return state.vwap;
};

// 
// Returns null if no VWAP has been established yet (engine just started).
// Detectors treat null as "no filter" — i.e. allow the alert through.
export const getVwap = async (symbol: string): Promise<number | null> => {
  const todayIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const key = `vwap:${symbol}:${todayIST}`;
  const raw = await redisClient.get(key);
  if (!raw) return null;
  return (JSON.parse(raw) as VwapState).vwap;
};

// 
// Called during engine boot in websocket.ts for each symbol in the universe.
// Prevents stale VWAP from a previous session bleeding into current session.
export const resetVwap = async (symbol: string): Promise<void> => {
  await redisClient.del(`vwap:${symbol}`);
};

// 
// Nifty bias logic:
//   > +0.15% above Nifty VWAP  → bullish  (broad market participating)
//   < -0.15% below Nifty VWAP  → bearish  (suppress all long-side alerts)
//   in between                  → neutral  (alerts allowed, lower conviction)
//
// 0.15% threshold avoids whipsaw around VWAP while still catching real regime shifts.
// Increase to 0.25% on high-volatility event days (Budget, RBI policy).
export const updateNiftyBias = async (
  niftyPrice: number,
  niftyVwap: number,
): Promise<void> => {
  const biasPct = ((niftyPrice - niftyVwap) / niftyVwap) * 100;

  let bias: MarketBias;
  if (biasPct > 0.15) bias = "bullish";
  else if (biasPct < -0.15) bias = "bearish";
  else bias = "neutral";

  await redisClient.set(NIFTY_BIAS_KEY, bias);
};

//
// Defaults to 'neutral' if Nifty VWAP hasn't been established yet.
// 'neutral' allows alerts — removes nothing. Safe default.
export const getMarketBias = async (): Promise<MarketBias> => {
  const raw = await redisClient.get(NIFTY_BIAS_KEY);
  return (raw as MarketBias | null) ?? "neutral";
};

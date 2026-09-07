# ANTIGRAVITY.md - Backtest Context

## Architecture Understanding (Step 0)
- The system is a real-time intraday signal detection engine for NSE, reading ticks from Fyers API.
- It operates using 26 detectors, out of which 9 are active. These detectors evaluate market conditions and emit signals.
- Signals are gated through a `JaneStreetFilter` sequence:
  1. **Regime Classifier**: Determines market regime (e.g., trending, ranging) based on Nifty returns entropy. Restricts REVERSION detectors during trending and MOMENTUM during ranging.
  2. **Bayesian Engine**: Updates signal probability based on multiple evidence sources (e.g., market bias, market structure, liquidity map).
  3. **EV (Expected Value)**: Calculates expectancy using signal win probability, configured risk-reward ratio, and a flat 2.0 point slippage assumption (for index).
  4. **Kelly Criterion**: Determines if the EV justifies the trade size.
- The `backtest/` harness replays historical data against the exact live detector code.
- To prevent real-world side effects (like dispatching to Telegram) and handle time accurately during fast replays, the backtest virtualizes the `Date` object (`core/clock.ts`) and Redis TTLs (`core/memoryRedis.ts`).

## Unclear / Inferred
- Fyers Token location: The original `access_token.txt` was expired. I verified that the token given by the user was actually an `auth_code`. I successfully exchanged it via the Fyers API and saved the valid `access_token.txt`.
- Circuit lock inference: The harness infers locked bands by checking for zero-range bars with volume. It's noted as a fidelity gap since Fyers doesn't provide historical circuit bands.

## Run Log
- Checked git branch (confirmed on `v2`).
- Exchanged `auth_code` for a valid Fyers token using a custom script (`exchange_token.ts`).
- Started `fetch --days 5` smoke test. Due to strict Fyers rate limits, I wrote a PowerShell loop (`fetch_loop.ps1`) to continually resume the fetch until all 91 symbols were cached.
- **Result**: Fetch completed successfully. Cache holds 62,75,939 1-minute bars and 16,736 daily bars for 91 symbols.
- Started backtest replay: `$env:BACKTEST_MODE="true"; npx tsx backtest/run.ts run --days 5`. Currently running.
- **Replay Complete:** Ran --days 5 smoke test.
  - HTML Report generated at: N:\trade\insider-quant-engine\backtest\output\backtest-report.html
  - Only Candle Accumulation Breakout (ARCHIVED_A) met the sufficient sample size (>30 gated trades).
  - Several ACTIVE detectors produced 0 raw signals (Nifty Trend Pulse, Nifty VWAP Reclaim).
  - Gap_And_Go_V2 passed the gate 26% of the time, overcoming the cold-start ceiling seen in the synthetic run.

## Pre-Full Run Fixes
- **Nifty VWAP**: Confirmed VWAP calculation is CORRECT in backtest (updates post-bar with TWAP, matching live fix). The 0 signals were due to Nifty Trend Pulse's volume condition (impossible in backtest due to constant tick count) and Nifty VWAP Reclaim's strict structural setup simply not occurring in the 5-day window.
- **fyersClient**: Hardened rate limiter to retry up to 20 times with a 60-second capped backoff.
- **Full Fetch & Run**: Initiated full historical fetch and run.

## Final Status
- **Full Replay**: Successfully ran 6.2M bars for 91 symbols over a 6-month period.
- **Results**: Detailed in the Full-Backtest-Report artifact.

## Gate & Regime Analysis
- **Regime Context (Dec 2025 - Sep 2026):** Analyzed Nifty50 daily bars. Return was -7.52% with a 15.18% max drawdown and a Choppiness Index of 49.17. This confirms the 6-month window was a choppy, mild bear market—a hostile regime for breakouts and trend-following, contextualizing the broad lack of positive expectancy.
- **EV Gate Slippage Bug:** Confirmed the EV gate (janeStreetFilter.ts) subtracted a flat 2.0 points for slippage. For low-priced equities (e.g., ₹200), this flat deduction destroyed the EV calculation, causing the gate to erroneously reject perfectly good trades. Patched to use a relative 5 bps slippage (matching the backtest assumptions). Initiated a new full replay to measure the E[R]g improvement.

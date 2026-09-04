# Prompt for Gemini / Antigravity: Run the Insider Quant Engine Backtest

## Context

You're working in the `insider-quant-engine` repo, on the `v2` branch. This is a personal quantitative trading system (TypeScript/Node.js) that generates trading signals via 26 "detector" modules, gates them through a `JaneStreetFilter` (Regime → Bayesian → EV → Kelly chain), and currently outputs Telegram alerts only — there is no live execution/risk/position-manager layer yet.

Claude Code has already **built and pushed** an isolated backtesting harness to this branch (`backtest/` — 16 modules). It:
- Imports the 26 real detector classes directly — no reimplemented logic.
- Recovers stop-loss/target levels via the live filter's own exported parser, so simulated exits can't drift from the real EV gate.
- Virtualizes the system clock and Redis TTLs internally (`backtest/core/clock.ts`, `backtest/core/memoryRedis.ts`) so a multi-week historical replay can run in seconds without waiting on real time or a live Redis instance.
- Has already been verified: `tsc` clean, 53/53 tests passing, and a 40-session synthetic demo run (75k bars, 300k ticks, 953 signals) completed successfully.

**What's not done yet, and is your job:** the harness has never run against real market data. This machine has no `.env` file and no Fyers API token yet.

## Your task

1. **Set up credentials.** Once a Fyers token is available, create the `.env` file with `FYERS_TOKEN_PATH` pointing to it (confirm the exact variable name/format expected by checking how the backtest scripts read it — don't guess the format).
2. **Run the data fetch.** Execute `npx tsx backtest/run.ts fetch`. This is a long-running (hours), resumable job pulling historical data via the Fyers API. Run it as a background task, and monitor for completion or failure. If it fails partway, it should be resumable — don't restart from scratch unless the resume mechanism itself is broken.
   - **Suggested first pass:** run a `--days 5` smoke test before committing to a full historical fetch, to confirm the pipeline works end to end before spending hours on the full run.
3. **Run the backtest replay.** Once data is fetched, execute `BACKTEST_MODE=true npx tsx backtest/run.ts run`.
4. **Report the raw output back** — the generated HTML report (`backtest/output/`), console summary, win rate / expectancy-in-R / sample-size numbers per detector, and anything that failed or looked wrong along the way (errors, detectors that produced zero signals, anything inconsistent with the synthetic-run behavior documented below).

## Hard boundaries — do not do these

- **Do not modify anything inside `backtest/core/`** (clock virtualization, Redis TTL virtualization, symbol classification). These exist to fix specific bugs Claude Code already found and documented (detectors read the wall clock directly; cooldowns are Redis TTLs that never expire in a fast replay). If something in this run looks broken and traces back to one of these modules, **stop and report it — don't attempt a fix.** A different agent patching this without the original context risks silently reintroducing the exact bugs it was built to avoid.
- **Do not touch `websocket.ts`, or anything in the live runtime path outside `backtest/`.** There's a known, separate, unfixed production bug there (`websocket.ts` misclassifies 5 equity symbols — RELIANCE, ULTRACEMCO, CEATLTD, BAJFINANCE, KAJARIACER — as options due to a bare substring match on "CE"/"PE"). It is intentionally out of scope for this task. Do not fix it, and do not let it block the backtest run — it's a live-detector-routing bug, not a backtest bug.
- **Do not interpret the results or make any pruning/keep-or-archive decision.** Two of 26 detectors (`DeltaHedgingPressure`, `OiLiquiditySweep`) cannot be backtested at all — Fyers' history API doesn't provide historical per-strike OI. That's expected; just confirm it and move on rather than trying to work around it. Beyond reporting the raw numbers and flagging anything structurally broken, leave the "what does this mean for which detectors survive" judgment call for a follow-up conversation.
- **Do not touch `main`.** Stay on `v2` (or whatever branch the backtest work already lives on).

## If you need your own file

If you need a persistent context file for this session or future ones (the way `AGENTS.md` and `CLAUDE.md` already exist in this repo for other agents), create one scoped to your own tool — e.g. `GEMINI.md` or `ANTIGRAVITY.md` at the repo root — documenting what you ran, what succeeded, what failed, and the exact commands/state needed to resume or re-run. Keep it factual and current-state-only; don't duplicate the full history already in `AGENTS.md`, just reference it. Do not edit `AGENTS.md` or `CLAUDE.md` directly.

## When you're done

Report back:
- Whether the fetch and run completed successfully, and how long each took.
- The location of the generated HTML report.
- Per-detector headline numbers (win rate, expectancy in R, sample size, gated vs. ungated signal counts).
- Any detector the report flags as insufficient sample size.
- Any errors, anomalies, or anything that required a judgment call you didn't feel authorized to make under the boundaries above.

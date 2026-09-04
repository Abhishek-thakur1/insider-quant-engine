# CLAUDE.md

**[`AGENTS.md`](./AGENTS.md) is the single source of truth for this repository. Read it
completely before making any change.** It documents the architecture, every calculation with its
exact formula, the signal-gating mathematics, the Redis key map, the known defects, and the
working conventions.

This file is deliberately thin. Do not duplicate content from `AGENTS.md` into it — two copies
of a fact become one stale fact.

---

## What this repo is

A signal detection and alerting engine for NSE intraday, on the Fyers API, output to Telegram.
**It does not place orders.** No execution layer, no position tracking, no P&L.

## Read in this order

1. `AGENTS.md` §0 (TL;DR) and §11 (state of the `v2` branch — what changed, what's open)
2. `AGENTS.md` §1 (architecture) and §4 (which detectors are actually live)
3. Whichever of §3 / §5 covers the maths you are touching
4. `AGENTS.md` §6 (defects) before you "fix" anything — several are deliberate
5. `backtest/README.md` only if you are touching `backtest/`

## Non-negotiables

1. **Check the detector is live before editing it.** 17 of 26 classes are not wired in — 15
   archived under `src/detectors/deprecated/`, 3 dormant in place. Grep
   `src/ingestion/websocket.ts` for the class name first.
2. **Ignore the commented-out archive blocks** at the bottom of most files. They are previous
   versions, kept as history.
3. **`trigger` strings are an interface, not prose.** The filter regex-parses `SL ₹x` / `T1 ₹y`
   out of them for the expected-value gate and keyword-matches them for regime classification.
   A new detector must emit those levels or it gets a fallback R:R and probably an EV rejection.
4. **Always set `regimeClass` and `detectorName`** on `AlertPayload`. `regimeClass` is the only
   non-guessing path through the REGIME hard gate. Omitting it already caused two real
   misclassifications (§6.9).
5. **Never block the synchronous socket handler.** All I/O belongs behind `tickEmitter`.
6. **Preserve the filter's fail-open behaviour** in `telegramWorker` — a bug in the confirmation
   layer must not silently kill the alert pipeline.
7. **Never fabricate a performance number.** Nothing in this repo has been measured. Every `L=`
   ratio, score weight and win-rate comment is an assumption. Say "untracked", not an estimate.
8. **Never touch `main`.** Work is on `v2`.
9. **Changing a threshold changes fire rate non-linearly.** Use `SHADOW_MODE=true`, collect
   `jsfilter:decisions`, and reason from the logged distribution.
10. **New Redis keys** go in the boot cleanup in `websocket.ts` and in `AGENTS.md` §7.

## Before you finish

```bash
npm run typecheck    # must stay at 0 errors
npm test             # must stay green
npm run lint
```

Update `AGENTS.md` in the same commit as any behaviour change. A stale brief is worse than none,
because the next agent will trust it.

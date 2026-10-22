#!/usr/bin/env bash
# ============================================================
# scripts/replay_sandbox.sh — run the Oct 15–22 liquid replay in a sealed container
#
#   --network none, NO env file, no token volume, BACKTEST_MODE=true.
#   1-minute candles mounted READ-ONLY from the screener_data volume; outputs to a
#   separate host directory. backtest/sandboxGuard.ts runs first and aborts on any
#   credential, a token file or network access. No DB, Redis or Telegram exists in here.
#
#   scripts/replay_sandbox.sh <image> <host-output-dir> [extra backtest/run.ts args]
#   e.g. scripts/replay_sandbox.sh insider-quant-engine-quant_engine:latest ~/evidence/replay-oct15-22
# ============================================================
set -euo pipefail
IMAGE=${1:?image}
OUT=${2:?host output dir}
shift 2
VOL=insider-quant-engine_screener_data
mkdir -p "$OUT"
exec docker run --rm --network none --env-file /dev/null \
  -e BACKTEST_MODE=true -e BACKTEST_RES=1 \
  -e REPLAY_SESSIONS=2026-10-15,2026-10-16,2026-10-19,2026-10-21,2026-10-22 \
  -v "$VOL":/replay-data:ro \
  -v "$OUT":/app/backtest/output \
  --entrypoint sh "$IMAGE" -c '
    set -e
    node --import tsx backtest/sandboxGuard.ts
    mkdir -p backtest/data/cache && ln -sfn /replay-data/candles/1 backtest/data/cache/res-1
    node --import tsx backtest/run.ts run --universe-file /replay-data/replay/liquid15cr.json \n      --sessions 2026-10-15,2026-10-16,2026-10-19,2026-10-21,2026-10-22 --label liquid15cr-oct15-22 \
      --detectors stock_momentum_breakout,volatility_contraction,nifty_opening_range_explosion,nifty_trend_pulse,nifty_vwap_reclaim '"$*"'
    node --import tsx backtest/replayReport.ts backtest/output/trades_liquid15cr-oct15-22.json /replay-data/replay > backtest/output/replay-report_liquid15cr-oct15-22.md
  '

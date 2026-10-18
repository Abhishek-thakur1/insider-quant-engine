-- 0003_flag_and_resolve_ghosts — flag known-bad rows, resolve ghost OPEN rows.
--
-- Touches only data_quality and status. Never exit_price, exit_time,
-- realized_pnl or r_multiple: the true outcome of these rows is unknown and
-- must not be invented.
--
-- RUN ORDER: apply this on the day the new engine code is deployed, before the
-- engine boots a second time. From that deploy on, prior-day SWING positions
-- are legitimately tracked across restarts; before it, every prior-day OPEN row
-- is untracked (websocket.ts used to delete trades:open at every boot).

-- Fake ₹0 / 0R closes written by the old quant_api boot sweep.
UPDATE paper_trades SET data_quality = array_append(data_quality, 'synthetic_close')
WHERE exit_reason = 'EOD_EXPIRED' AND NOT ('synthetic_close' = ANY(data_quality));

-- Capital-skipped signals (actual_size 0): PnL is ₹0 by construction.
UPDATE paper_trades SET data_quality = array_append(data_quality, 'capital_skipped')
WHERE actual_size = 0 AND NOT ('capital_skipped' = ANY(data_quality));

-- Nifty option-routed rows carry index-level prices and never tick.
UPDATE paper_trades SET data_quality = array_append(data_quality, 'index_option_proxy')
WHERE symbol ~ ' (CE|PE)$' AND NOT ('index_option_proxy' = ANY(data_quality));

-- Before capital-constrained sizing (2026-09-14): qty/actual_size were backfilled per trade in isolation.
UPDATE paper_trades SET data_quality = array_append(data_quality, 'pre_sizing_approx')
WHERE entry_time < TIMESTAMPTZ '2026-09-14 00:00:00+05:30' AND NOT ('pre_sizing_approx' = ANY(data_quality));

-- Before 469a568 (2026-10-05 21:32 IST) duration_class was never passed through; later
-- SWING labels on such rows may be in-place relabels by scripts/fix_duration_class.ts.
UPDATE paper_trades SET data_quality = array_append(data_quality, 'duration_unverified')
WHERE entry_time < TIMESTAMPTZ '2026-10-05 21:32:00+05:30' AND NOT ('duration_unverified' = ANY(data_quality));

-- Ghost rows: still OPEN from a prior IST day, tracked by no process. No exit is recorded.
UPDATE paper_trades
SET status = 'ORPHANED',
    data_quality = CASE WHEN 'orphaned' = ANY(data_quality) THEN data_quality
                        ELSE array_append(data_quality, 'orphaned') END
WHERE status = 'OPEN'
  AND (entry_time AT TIME ZONE 'Asia/Kolkata')::date < (now() AT TIME ZONE 'Asia/Kolkata')::date;

-- Today's capital-skipped rows: not positions. The engine still closes them (status stays SKIPPED).
UPDATE paper_trades SET status = 'SKIPPED'
WHERE status = 'OPEN' AND actual_size = 0;

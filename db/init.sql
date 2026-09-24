CREATE TABLE IF NOT EXISTS paper_trades (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  detector TEXT NOT NULL,
  direction TEXT NOT NULL,           -- LONG / SHORT
  entry_price NUMERIC NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  stop_price NUMERIC,
  target_price NUMERIC,
  exit_price NUMERIC,                -- NULL while open
  exit_time TIMESTAMPTZ,             -- NULL while open
  status TEXT NOT NULL,              -- OPEN / CLOSED
  realized_pnl NUMERIC,              -- NULL while open
  regime_class TEXT,                 -- TRENDING / CHOPPY / TRANSITION at entry time
  gated BOOLEAN,                     -- whether this signal passed the JaneStreetFilter
  duration_class TEXT,               -- INTRADAY / SWING — derived from detector
  created_at TIMESTAMPTZ DEFAULT now()
);

-- entry_time: used by positionTracker UPDATE WHERE entry_time = ...
CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON paper_trades (entry_time);
-- exit_time: primary filter for history queries and heatmap (added after bucketing fix)
CREATE INDEX IF NOT EXISTS idx_trades_exit_time  ON paper_trades (exit_time DESC);
-- status: needed for WHERE status = 'OPEN' / 'CLOSED' scans at scale
CREATE INDEX IF NOT EXISTS idx_trades_status     ON paper_trades (status);
-- symbol: needed for positionTracker UPDATE WHERE symbol = ...
CREATE INDEX IF NOT EXISTS idx_trades_symbol     ON paper_trades (symbol);
-- detector: for per-detector history filter
CREATE INDEX IF NOT EXISTS idx_trades_detector   ON paper_trades (detector);
-- partial index: fast scan of open positions (tiny set, most useful)
CREATE INDEX IF NOT EXISTS idx_trades_open       ON paper_trades (entry_time DESC) WHERE status = 'OPEN';

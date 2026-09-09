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
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trades_date ON paper_trades (entry_time);
CREATE INDEX IF NOT EXISTS idx_trades_detector ON paper_trades (detector);

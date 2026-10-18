-- 0001_baseline — the schema half of the old quant_api boot block.
--
-- Idempotent on purpose: on the live database these columns and indexes already
-- exist (the boot block created them), so this is a no-op there. On a fresh
-- database it fills the gaps db/init.sql leaves.
--
-- The old block's DATA backfills (qty, r_multiple, actual_size, duration_class,
-- realized_pnl, and the EOD_EXPIRED close of prior-day OPEN rows) are
-- deliberately NOT carried over. They already ran on the live data many times;
-- re-running them on every boot was the defect this runner replaces.

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS r_multiple     NUMERIC(10,2);
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS qty            NUMERIC(10,2);
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS capital_gated  BOOLEAN DEFAULT FALSE;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS actual_size    NUMERIC(10,2);
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS duration_class TEXT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_reason    TEXT;

CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON paper_trades (entry_time);
CREATE INDEX IF NOT EXISTS idx_trades_exit_time  ON paper_trades (exit_time DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status     ON paper_trades (status);
CREATE INDEX IF NOT EXISTS idx_trades_symbol     ON paper_trades (symbol);
CREATE INDEX IF NOT EXISTS idx_trades_detector   ON paper_trades (detector);
CREATE INDEX IF NOT EXISTS idx_trades_open       ON paper_trades (entry_time DESC) WHERE status = 'OPEN';

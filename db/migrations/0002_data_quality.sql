-- 0002_data_quality — per-row provenance flags.
--
-- An empty array means "no known problem", not "verified". Flags are only ever
-- added; outcome columns are never rewritten to make a row look clean.
-- Flag vocabulary is documented in AGENTS.md §14 and docs/DATA_PROVENANCE.md.

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS data_quality TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_trades_data_quality ON paper_trades USING GIN (data_quality);

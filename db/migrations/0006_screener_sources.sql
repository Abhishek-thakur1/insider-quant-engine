-- 0005_screener_sources — allow screener v2 promotion sources in signals
--
-- Screener v2 tags each watchlist symbol SCREENER_LEADER (Tier 1) or
-- SCREENER_SETUP (Tier 2). 0004 limited promotion_source to the v1 values.
-- Additive: every existing value stays valid ('SCREENER' remains for rows logged
-- while a legacy watchlist without meta was in use). No row is touched.
--
-- The 0004 CHECK was an inline column constraint, which Postgres names
-- <table>_<column>_check.
--
-- Reverse (only if no row uses the new values):
--   ALTER TABLE signals DROP CONSTRAINT signals_promotion_source_check;
--   ALTER TABLE signals ADD CONSTRAINT signals_promotion_source_check
--     CHECK (promotion_source IN ('CORE', 'SCREENER', 'ANOMALY', 'INDEX', 'UNKNOWN'));
--   DELETE FROM schema_migrations WHERE version = '0005';

ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_promotion_source_check;
ALTER TABLE signals ADD CONSTRAINT signals_promotion_source_check
    CHECK (promotion_source IN ('CORE', 'SCREENER', 'SCREENER_LEADER', 'SCREENER_SETUP', 'ANOMALY', 'INDEX', 'UNKNOWN'));

-- 0008_daily_list_sources — allow the daily watchlist's promotion sources in signals
--
-- The daily list (dw-3, watchlist_daily.json) tags each rotating symbol by how it was picked:
-- DAILY_SCORE (by score) or DAILY_TURNOVER (by turnover); its core group logs CORE. 0006 limited
-- promotion_source to the screener values. Additive: every existing value stays valid and no row
-- is touched. Until this is applied the engine logs the rotating names as SCREENER
-- (websocket.ts: schemaProblem → dailyListSources legacy), so a pending 0008 never breaks inserts.
--
-- Reverse (only if no row uses the new values):
--   ALTER TABLE signals DROP CONSTRAINT signals_promotion_source_check;
--   ALTER TABLE signals ADD CONSTRAINT signals_promotion_source_check
--     CHECK (promotion_source IN ('CORE', 'SCREENER', 'SCREENER_LEADER', 'SCREENER_SETUP', 'ANOMALY', 'INDEX', 'UNKNOWN'));
--   DELETE FROM schema_migrations WHERE version = '0008';

DO $$
BEGIN
    IF to_regclass('public.signals') IS NULL THEN
        RAISE EXCEPTION '0008_daily_list_sources requires 0004_signals (the signals table). Apply 0004 first.';
    END IF;
END
$$;

ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_promotion_source_check;
ALTER TABLE signals ADD CONSTRAINT signals_promotion_source_check
    CHECK (promotion_source IN ('CORE', 'DAILY_SCORE', 'DAILY_TURNOVER', 'SCREENER', 'SCREENER_LEADER', 'SCREENER_SETUP', 'ANOMALY', 'INDEX', 'UNKNOWN'));

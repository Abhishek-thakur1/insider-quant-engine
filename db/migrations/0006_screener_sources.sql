-- 0006_screener_sources — allow screener v2 promotion sources in signals
--
-- NUMBERING: 0005 is reserved for Part D (Nifty index-level tracking, branch
-- not yet built). This migration depends ONLY on 0004_signals (it alters the
-- signals table) and is independent of 0005. Required deploy order:
-- 0004 (signals) before 0006 (this). The runner applies pending migrations in
-- version order but does not refuse a gap, so the guard below fails loudly —
-- and the runner rolls the transaction back — if 0004 has not been applied.
--
-- Screener v2 tags each watchlist symbol SCREENER_LEADER (Tier 1) or
-- SCREENER_SETUP (Tier 2). 0004 limited promotion_source to the v1 values.
-- Additive: every existing value stays valid ('SCREENER' remains for rows logged
-- while a legacy watchlist without meta was in use). No row is touched.
--
-- The 0004 CHECK was an inline column constraint, which Postgres names
-- <table>_<column>_check (verified on postgres:15, 2026-10-20).
--
-- Reverse (only if no row uses the new values):
--   ALTER TABLE signals DROP CONSTRAINT signals_promotion_source_check;
--   ALTER TABLE signals ADD CONSTRAINT signals_promotion_source_check
--     CHECK (promotion_source IN ('CORE', 'SCREENER', 'ANOMALY', 'INDEX', 'UNKNOWN'));
--   DELETE FROM schema_migrations WHERE version = '0006';

DO $$
BEGIN
    IF to_regclass('public.signals') IS NULL THEN
        RAISE EXCEPTION '0006_screener_sources requires 0004_signals (the signals table). Apply 0004 first — deploy order: signals before screener.';
    END IF;
END
$$;

ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_promotion_source_check;
ALTER TABLE signals ADD CONSTRAINT signals_promotion_source_check
    CHECK (promotion_source IN ('CORE', 'SCREENER', 'SCREENER_LEADER', 'SCREENER_SETUP', 'ANOMALY', 'INDEX', 'UNKNOWN'));

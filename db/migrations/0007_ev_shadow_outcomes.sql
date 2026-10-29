-- 0007_ev_shadow_outcomes — simulated outcomes of fires the EV gate rejected (observation only).
--
-- Purely additive: one new table and one index. No existing table, column, row or index is
-- touched. It is deliberately NOT paper_trades, and has no flag on it: every existing stat, API
-- endpoint and dashboard total reads paper_trades (or signals), so these rows can't leak into them.
-- Written only by core/evShadow.ts, and only when EV_SHADOW_ENABLED=true (default off).
-- After this migration a pg_dump holds 4 TABLE DATA entries (was 3): update the deploy gate.
--
-- Reverse (after keeping a backup):
--   DROP TABLE ev_shadow_outcomes; DELETE FROM schema_migrations WHERE version = '0007';

CREATE TABLE ev_shadow_outcomes (
    id              SERIAL PRIMARY KEY,
    -- signals.signal_id of the rejected fire. No FK: the signals row is written asynchronously
    -- (db/signalLog.ts) and may land after this one.
    signal_id       UUID,
    trade_date      DATE NOT NULL,
    symbol          TEXT NOT NULL,
    -- the price series the outcome is evaluated on: the symbol itself, or NSE:NIFTY50-INDEX for a
    -- Nifty option fire (whose levels are index-level; data_quality then has 'index_proxy')
    tracked_symbol  TEXT NOT NULL,
    detector        TEXT,
    direction       TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    score           NUMERIC,
    ev              NUMERIC,
    entry_price     NUMERIC NOT NULL,
    stop_price      NUMERIC NOT NULL,
    target_price    NUMERIC NOT NULL,
    entry_time      TIMESTAMPTZ NOT NULL,
    duration_class  TEXT NOT NULL DEFAULT 'INTRADAY',
    status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'UNRESOLVED')),
    exit_price      NUMERIC,
    exit_time       TIMESTAMPTZ,
    exit_reason     TEXT CHECK (exit_reason IN ('STOP_LOSS', 'TARGET', 'TIME')),
    r_multiple      NUMERIC(10, 4),
    data_quality    TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ev_shadow_outcomes_trade_date_idx ON ev_shadow_outcomes (trade_date);

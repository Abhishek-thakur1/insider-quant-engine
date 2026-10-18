-- 0004_signals — one row per detector fire (every sendTelegramAlert call).
--
-- Purely additive: creates the signals table and its indexes. No existing
-- table, column, row or index is modified. The FK adds a constraint that
-- references paper_trades(id), which briefly takes a SHARE ROW EXCLUSIVE lock
-- on paper_trades — apply outside market hours.
--
-- Reverse (after restoring/keeping a backup):
--   DROP TABLE signals; DELETE FROM schema_migrations WHERE version = '0004';
--
-- Gate semantics: only REGIME and EV can reject; Bayesian and Kelly are score
-- components; the score threshold is the third rejection point. A stage that
-- never ran is NULL (not evaluated), never PASS. Column docs: AGENTS.md §14b.
-- No retention job yet (owner decision 2026-10-18): revisit once volume is measured.

CREATE TABLE signals (
    signal_id               UUID PRIMARY KEY,
    fired_at                TIMESTAMPTZ NOT NULL,
    trade_date              DATE NOT NULL,                -- IST calendar day of fired_at
    symbol                  TEXT NOT NULL,
    detector                TEXT NOT NULL,
    direction               TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
    price                   NUMERIC,
    trigger                 TEXT,
    duration_class          TEXT,
    regime_class            TEXT,                         -- as declared by the detector

    -- Levels the EV gate saw (parsed from the trigger text)
    trigger_sl              NUMERIC,
    trigger_t1              NUMERIC,
    levels_parsed           BOOLEAN NOT NULL,
    -- Levels the paper trade tracks (NULL if the signal never reached sizing)
    entry_price             NUMERIC,
    stop_price              NUMERIC,
    target_price            NUMERIC,

    -- Regime (hard gate)
    regime_result           TEXT CHECK (regime_result IN ('PASS', 'REJECT')),
    regime_reason           TEXT,
    market_regime           TEXT,
    entropy                 NUMERIC,
    -- Bayesian (score component)
    bayesian_posterior      NUMERIC,
    bayesian_points         NUMERIC,
    bayesian_reason         TEXT,
    -- EV (hard gate)
    ev_result               TEXT CHECK (ev_result IN ('PASS', 'REJECT')),
    ev_value                NUMERIC,
    ev_reason               TEXT,
    -- Kelly (score component)
    kelly_half              NUMERIC,
    kelly_points            NUMERIC,
    kelly_reason            TEXT,
    -- Score threshold (third rejection point)
    score                   NUMERIC,
    score_threshold         NUMERIC,
    score_result            TEXT CHECK (score_result IN ('PASS', 'BELOW_THRESHOLD')),

    filter_result           TEXT CHECK (filter_result IN ('PASSED', 'REJECTED', 'ERROR')),
    rejected_at             TEXT CHECK (rejected_at IN ('REGIME', 'EV', 'SCORE')),
    shadow_mode             BOOLEAN NOT NULL,
    breakdown               JSONB,                        -- every score component, lossless

    capital_outcome         TEXT CHECK (capital_outcome IN ('TRADED', 'REDUCED', 'SKIPPED_CAPITAL')),
    qty                     NUMERIC,
    actual_size             NUMERIC,
    promotion_source        TEXT NOT NULL CHECK (promotion_source IN ('CORE', 'SCREENER', 'ANOMALY', 'INDEX', 'UNKNOWN')),

    alert_sent              BOOLEAN NOT NULL,
    alert_suppressed_reason TEXT CHECK (alert_suppressed_reason IN (
                                'FILTER_REJECTED', 'FILTER_ERROR', 'NOT_GATED', 'CAPITAL_SKIP', 'ZERO_SIZE',
                                'DUPLICATE', 'CAP_REACHED', 'SEND_FAILED', 'WORKER_ERROR')),
    CHECK (alert_sent = (alert_suppressed_reason IS NULL)),

    trade_id                INTEGER REFERENCES paper_trades (id) ON DELETE SET NULL,
    data_quality            TEXT[] NOT NULL DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Safety net against the same fire being logged twice (e.g. a double call in one ms).
    -- A re-fire after a detector's cooldown has a different fired_at and is its own row.
    CONSTRAINT signals_fire_unique UNIQUE (detector, symbol, direction, fired_at)
);

CREATE INDEX idx_signals_fired_at        ON signals (fired_at DESC);
CREATE INDEX idx_signals_date_detector   ON signals (trade_date, detector);
CREATE INDEX idx_signals_symbol_date     ON signals (symbol, trade_date);
CREATE INDEX idx_signals_trade_id        ON signals (trade_id) WHERE trade_id IS NOT NULL;

// ============================================================
// backtest/emaTrend.ts — re-export of the Nifty EMA study engine
//
// The engine moved to src/core/emaTrend.ts (2026-10-21) so the live shadow
// detector (src/detectors/shadow/niftyEmaShadow.ts) runs the SAME code as the
// study: one implementation, parity by construction. Unchanged otherwise.
// ============================================================

export * from '../src/core/emaTrend.js'

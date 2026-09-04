// ============================================================
// backtest/config.ts — every simulation assumption in one place
//
// Anything here that is an ASSUMPTION rather than a measured fact is labelled.
// The HTML report prints this whole block so a reader can see what the numbers
// were produced under.
// ============================================================

import path from 'path'

export const NIFTY_SYMBOL = 'NSE:NIFTY50-INDEX'

export const BACKTEST_ROOT = path.resolve(process.cwd(), 'backtest')
export const DATA_DIR = path.join(BACKTEST_ROOT, 'data', 'cache')
export const OUTPUT_DIR = path.join(BACKTEST_ROOT, 'output')

// ── Data acquisition ───────────────────────────────────────────────────────
export const DATA = {
	/** Fyers history resolutions. 'D' for the daily store, '1' for intraday. */
	dailyResolution: 'D',
	intradayResolution: '1',

	/**
	 * Fyers caps getHistory to a limited span per call. Daily tolerates long
	 * ranges; 1-minute does not. These are conservative chunk sizes — verify
	 * against current Fyers docs before a long run.
	 */
	dailyChunkDays: 365,
	intradayChunkDays: 30,

	/** Shared with the live seeder's limiter. Tune to the history endpoint. */
	maxRequestsPerSecond: 5,
	maxRetries: 3,

	/** Lookback target. Intraday history availability is the real constraint. */
	lookbackTradingDays: 180,
} as const

// ── Simulation assumptions ─────────────────────────────────────────────────
export const SIM = {
	/**
	 * ASSUMPTION — slippage. Applied to entry and to exit, in basis points of
	 * price, so it scales across a ₹50 stock and a 25,000 index (unlike the
	 * live filter's flat 2.0 points, see AGENTS.md §5.3). 5 bps ≈ ₹0.25 on a
	 * ₹500 stock. Cash equity intraday on liquid NSE names.
	 */
	slippageBps: 5,

	/**
	 * ASSUMPTION — intra-bar path. A 1-minute OHLC bar does not say whether
	 * the high or the low came first. When both the stop and the target fall
	 * inside the same bar we resolve it PESSIMISTICALLY: the stop is assumed
	 * to have been hit first. This biases results downward rather than
	 * flattering them.
	 */
	pessimisticIntraBar: true,

	/**
	 * ASSUMPTION — default exit for detectors that define no exit rule.
	 * Detectors that DO embed `SL ₹x | T1 ₹y` in their trigger use their own
	 * levels (parsed with the live filter's own parser). Everything else falls
	 * back to this, and the report labels which basis each detector used.
	 */
	defaultStopPct: 0.5, // % from entry
	defaultTargetR: 1.5, // R multiple

	/** Intraday square-off. MIS positions are force-closed by the broker. */
	forceExitIstMinutes: 15 * 60 + 15, // 15:15 IST

	/**
	 * ASSUMPTION — circuit-lock proxy. Fyers getHistory does not return the
	 * per-symbol circuit band, so a lock cannot be read directly. A bar is
	 * TREATED as locked when it has zero range and non-trivial volume
	 * (open==high==low==close) — the signature of a symbol pinned at a band.
	 * A stop inside such a bar is NOT filled; the exit is deferred to the next
	 * bar with a real range, per the live spec. This is inference, not data:
	 * see backtest/README.md "Known fidelity gaps".
	 */
	circuitLockZeroRange: true,
} as const

// ── Metrics discipline ─────────────────────────────────────────────────────
export const METRICS = {
	/**
	 * 30 gated trades to earn a headline number. Anything under is reported and
	 * flagged INSUFFICIENT SAMPLE.
	 *
	 * CAVEAT — READ THIS BEFORE TRUSTING AN EXPECTANCY. The original rationale
	 * for 30 assumed a 45-55% win rate, where the 95% CI on a win-rate estimate
	 * is about ±18pp at n=30. That reasoning does not transfer to the momentum
	 * profile the Qullamaggie spec targets: 25-30% win rate with winners running
	 * 10-20x initial risk (docs/qullamaggie-spec-v2.md, "Performance framing").
	 *
	 * At a 27% win rate, 30 trades is roughly EIGHT winners. Expectancy is then
	 * a mean dominated by a handful of tail observations, and 30 trades is only
	 * enough to say "this fired often enough to look at" — not enough to
	 * estimate its edge. Raising the threshold on no data would be guesswork, so
	 * instead every detector reports WIN CONCENTRATION (see sim/metrics.ts): if
	 * one trade supplied most of the gains, the expectancy is unreliable however
	 * many trades there were.
	 */
	minGatedTradesForConfidence: 30,

	/**
	 * Above this share of gross winnings coming from a single trade, the
	 * expectancy is flagged as tail-dependent in the report.
	 */
	maxTopWinShare: 0.5,
} as const

// ── Filter configuration used during replay ────────────────────────────────
// The live filter reads CONFIRMATION_THRESHOLD and SHADOW_MODE from the
// environment. The harness must NOT change live behaviour, so it does not
// write these — it records whatever was in effect for the report.
export const filterEnvSnapshot = () => ({
	confirmationThreshold: Number(process.env.CONFIRMATION_THRESHOLD) || 78,
	shadowMode: process.env.SHADOW_MODE === 'true',
})

export type ExitBasis = 'detector-defined' | 'harness-default' | 'not-backtestable'

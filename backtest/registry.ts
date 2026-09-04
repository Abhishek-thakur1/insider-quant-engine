// ============================================================
// backtest/registry.ts — all 26 detector classes, imported as-is
//
// This file is the only place that knows the full detector inventory. It
// imports the REAL classes — including the archived ones under
// src/detectors/deprecated/, which is exactly why the pruning moved them
// instead of deleting them. No detector logic is reimplemented anywhere in
// backtest/.
//
// `tier` records the pruning decision each detector received, so the report
// can compare backtest results against that decision (goal doc §5).
//
// `backtestable` flags detectors whose edge cannot be reconstructed from
// historical OHLCV. Those are reported as NOT BACKTESTABLE with a reason
// rather than being run and given a misleadingly small sample.
// ============================================================

import type { IDetector } from '../src/core/types.js'
import type { DetectorType } from '../src/utils/regimeDetector.js'
import type { ExitBasis } from './config.js'

// ── ACTIVE (8) ─────────────────────────────────────────────────────────────
import { NiftyOpeningRangeExplosionDetector } from '../src/detectors/v2/niftyOpeningRangeExplosionDetector.js'
import { NiftyTrendPulseDetector } from '../src/detectors/v2/niftyTrendPulseDetector.js'
import { NiftyVwapReclaimDetector } from '../src/detectors/v2/niftyVwapReclaimDetector.js'
import { StockMomentumBreakoutDetector } from '../src/detectors/v2/stockMomentumBreakoutDetector.js'
import { VolatilityContraction } from '../src/detectors/v2/high_alpha/VolatilityContraction.js'
import { GapAndGoMomentum } from '../src/detectors/v2/high_alpha/GapAndGoMomentum.js'
import { OiLiquiditySweepDetector } from '../src/detectors/oiLiquiditySweepDetector.js'
import { DeltaHedgingPressureDetector } from '../src/detectors/deltahedgingpressuredetector.js'

// ── DORMANT, not archived (3) ──────────────────────────────────────────────
import { OrbDetector } from '../src/detectors/orbDetector.js'
import { MultiTimeframeBreakoutDetector } from '../src/detectors/Multitimeframebreakoutdetector.js'
import { LiquiditySweepDetector } from '../src/detectors/liquiditySweepDetector.js'

// ── ARCHIVED (15) ──────────────────────────────────────────────────────────
import { NiftyLiquiditySweep } from '../src/detectors/deprecated/NiftyLiquiditySweep.js'
import { OrderFlowExhaustionDetector } from '../src/detectors/deprecated/Orderflowexhaustiondetector.js'
import { SmartMoneyDivergenceDetector } from '../src/detectors/deprecated/smartmoneydivergencedetector.js'
import { VwapStdevReversionDetector } from '../src/detectors/deprecated/vwapStdevReversionDetector.js'
import { VwapPullbackDetector } from '../src/detectors/deprecated/vwapPullbackDetector.js'
import { VwapCrossoverDetector } from '../src/detectors/deprecated/vwapCrossoverDetector.js'
import { ValueZoneScalpDetector } from '../src/detectors/deprecated/valueZoneScalpDetector.js'
import { LiquidityTrapDetector } from '../src/detectors/deprecated/liquidityTrapDetector.js'
import { NiftyOptionsDetector } from '../src/detectors/deprecated/niftyOptionsDetector.js'
import { MorningMomentumDetector } from '../src/detectors/deprecated/morningMomentumDetector.js'
import { CandleBreakoutDetector } from '../src/detectors/deprecated/candleBreakoutDetector.js'
import { VcpDetector } from '../src/detectors/deprecated/vcpDetector.js'
import { ParabolicRvolSweepDetector } from '../src/detectors/deprecated/parabolicRvolSweepDetector.js'
import { VolumeSpikeDetector } from '../src/detectors/deprecated/volumeSpikeDetector.js'
import { EquityLiquiditySweepDetector } from '../src/detectors/deprecated/equityLiquiditySweepDetector.js'

export type Tier = 'ACTIVE' | 'DORMANT' | 'ARCHIVED_A' | 'ARCHIVED_C'
export type Scope = 'nifty-singleton' | 'per-symbol'

export interface DetectorSpec {
	/** Stable id used in output files and the report. */
	id: string
	/** `IDetector.name` as the class reports it — what the filter classifies on. */
	displayName: string
	scope: Scope
	tier: Tier
	bias: DetectorType | 'MEAN_REVERSION'
	exitBasis: ExitBasis
	/** false → reported as NOT BACKTESTABLE with `notBacktestableReason`. */
	backtestable: boolean
	notBacktestableReason?: string
	/** Fidelity caveats surfaced next to this detector's numbers. */
	caveats?: string[]
}

/** Detectors driven by tick counts rather than clock time — see caveat text. */
const TICK_COUNT_CAVEAT =
	'Tick-count based: its windows are measured in ticks, not minutes. Replay synthesises 4 ticks per 1-min bar, so a 20-tick window spans ~5 simulated minutes versus possibly seconds live. Behaviour is NOT comparable to live.'

const OPTION_ROUTED_CAVEAT =
	'Routes to an option strike via getBestStrike(). Fyers getHistory provides no historical option chain, so strike selection falls back to ATM with premium 0 and the Bayesian OI-wall evidence is always neutral. Index-level entry/exit levels are still simulated faithfully.'

export const REGISTRY: DetectorSpec[] = [
	// ── ACTIVE ───────────────────────────────────────────────────────────────
	{
		id: 'stock_momentum_breakout',
		displayName: 'Stock Momentum Breakout',
		scope: 'per-symbol',
		tier: 'ACTIVE',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
	},
	{
		id: 'nifty_opening_range_explosion',
		displayName: 'Nifty Opening Range Explosion',
		scope: 'nifty-singleton',
		tier: 'ACTIVE',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [OPTION_ROUTED_CAVEAT],
	},
	{
		id: 'nifty_trend_pulse',
		displayName: 'Nifty Trend Pulse',
		scope: 'nifty-singleton',
		tier: 'ACTIVE',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [OPTION_ROUTED_CAVEAT],
	},
	{
		id: 'nifty_vwap_reclaim',
		displayName: 'Nifty VWAP Reclaim',
		scope: 'nifty-singleton',
		tier: 'ACTIVE',
		bias: 'UNIVERSAL',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [OPTION_ROUTED_CAVEAT],
	},
	{
		id: 'volatility_contraction',
		displayName: 'Volatility_Contraction_V2',
		scope: 'per-symbol',
		tier: 'ACTIVE',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [
			'Gated by isDailyTrendAligned(), which reads HTF_TREND:{symbol}. Nothing writes that key, so the daily-trend filter fails open in backtest exactly as it does live (AGENTS.md §6.3).',
		],
	},
	{
		id: 'gap_and_go',
		displayName: 'Gap_And_Go_V2',
		scope: 'per-symbol',
		tier: 'ACTIVE',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
	},
	{
		id: 'oi_liquidity_sweep',
		displayName: 'Institutional OI Liquidity Sweep',
		scope: 'nifty-singleton',
		tier: 'ACTIVE',
		bias: 'UNIVERSAL',
		exitBasis: 'detector-defined',
		backtestable: false,
		notBacktestableReason:
			'Arms only when spot pierces the max-OI call/put wall from getWallStrikes(), which reads the live option tick store. Fyers getHistory returns no historical per-strike OI, so the walls are always null and the state machine can never leave WAITING. Backtesting this needs a historical option-chain source.',
	},
	{
		id: 'delta_hedging_pressure',
		displayName: 'Delta Hedging Pressure (Gamma Squeeze)',
		scope: 'nifty-singleton',
		tier: 'ACTIVE',
		bias: 'UNIVERSAL',
		exitBasis: 'not-backtestable',
		backtestable: false,
		notBacktestableReason:
			'Its entire signal is per-strike premium velocity plus OI growth, fed by updateStrikeTick() from the option tick stream. Neither historical option premiums at tick granularity nor historical per-strike OI are available from getHistory. Cannot be approximated from index OHLCV without inventing the signal.',
	},

	// ── DORMANT (not archived) ───────────────────────────────────────────────
	{
		id: 'orb',
		displayName: 'ORB Breakout',
		scope: 'per-symbol',
		tier: 'DORMANT',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [
			'Also the sole writer of orb:15min:* / orb:30min:*. The harness always instantiates it so the two detectors that READ those keys (LiquiditySweepDetector, NiftyLiquiditySweep) can be backtested at all.',
		],
	},
	{
		id: 'multi_timeframe_breakout',
		displayName: 'Multi-TF Institutional Breakout',
		scope: 'per-symbol',
		tier: 'DORMANT',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
	},
	{
		id: 'liquidity_sweep_sniper',
		displayName: 'Institutional Liquidity Sniper',
		scope: 'nifty-singleton',
		tier: 'DORMANT',
		bias: 'UNIVERSAL',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [
			'Depends on orb:15min:* being present, so it only produces signals because the harness also runs OrbDetector.',
			OPTION_ROUTED_CAVEAT,
		],
	},

	// ── ARCHIVED — Tier A ────────────────────────────────────────────────────
	{
		id: 'order_flow_exhaustion',
		displayName: 'Order Flow Exhaustion Scalper',
		scope: 'nifty-singleton',
		tier: 'ARCHIVED_A',
		bias: 'MEAN_REVERSION',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [OPTION_ROUTED_CAVEAT],
	},
	{
		id: 'smart_money_divergence',
		displayName: 'Smart Money Price-Volume Divergence (Wyckoff)',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'MEAN_REVERSION',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [
			'The only detector that builds CLOCK-ALIGNED candles, so its bars line up with the source data exactly — its numbers are the most directly comparable to live of the whole set.',
		],
	},
	{
		id: 'vwap_stdev_reversion',
		displayName: 'Statistical VWAP SD Reversion',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'MEAN_REVERSION',
		exitBasis: 'detector-defined',
		backtestable: true,
	},
	{
		id: 'vwap_pullback',
		displayName: 'Nifty VWAP Defense Scalp',
		scope: 'nifty-singleton',
		tier: 'ARCHIVED_A',
		bias: 'MEAN_REVERSION',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [OPTION_ROUTED_CAVEAT],
	},
	{
		id: 'vwap_crossover',
		displayName: 'Nifty VWAP Crossover Sniper',
		scope: 'nifty-singleton',
		tier: 'ARCHIVED_A',
		bias: 'MEAN_REVERSION',
		exitBasis: 'harness-default',
		backtestable: true,
		caveats: [OPTION_ROUTED_CAVEAT],
	},
	{
		id: 'value_zone_scalp',
		displayName: 'Value Zone Trend Ride',
		scope: 'nifty-singleton',
		tier: 'ARCHIVED_A',
		bias: 'MEAN_REVERSION',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [
			'Needs 21 three-minute candles to seed its EMA — roughly 63 minutes — so it cannot arm before ~10:20 IST in any simulated session.',
			OPTION_ROUTED_CAVEAT,
		],
	},
	{
		id: 'liquidity_trap',
		displayName: 'Institutional Liquidity Sweep (Trap)',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'MEAN_REVERSION',
		exitBasis: 'detector-defined',
		backtestable: true,
	},
	{
		id: 'nifty_options_scalper',
		displayName: 'Nifty Options Scalper',
		scope: 'nifty-singleton',
		tier: 'ARCHIVED_A',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [OPTION_ROUTED_CAVEAT],
	},
	{
		id: 'morning_momentum',
		displayName: 'Morning Momentum Ignition',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'MOMENTUM',
		exitBasis: 'harness-default',
		backtestable: true,
	},
	{
		id: 'candle_breakout',
		displayName: 'Candle Accumulation Breakout',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
	},
	{
		id: 'vcp',
		displayName: 'VCP Institutional Breakout',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'MOMENTUM',
		exitBasis: 'harness-default',
		backtestable: true,
		caveats: [TICK_COUNT_CAVEAT],
	},
	{
		id: 'parabolic_rvol_sweep',
		displayName: 'Late-Day Parabolic RVOL Sweep',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'MOMENTUM',
		exitBasis: 'detector-defined',
		backtestable: true,
	},
	{
		id: 'volume_spike',
		displayName: 'Institutional Volume Absorption',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'MOMENTUM',
		exitBasis: 'harness-default',
		backtestable: true,
	},
	{
		id: 'equity_liquidity_sweep',
		displayName: 'Equity Structural Liquidity Sweep',
		scope: 'per-symbol',
		tier: 'ARCHIVED_A',
		bias: 'UNIVERSAL',
		exitBasis: 'detector-defined',
		backtestable: true,
	},

	// ── ARCHIVED — Tier C ────────────────────────────────────────────────────
	{
		id: 'nifty_liquidity_sweep_v2',
		displayName: 'Nifty_Liquidity_Sweep_V2',
		scope: 'nifty-singleton',
		tier: 'ARCHIVED_C',
		bias: 'MEAN_REVERSION',
		exitBasis: 'detector-defined',
		backtestable: true,
		caveats: [
			'Archived as dead code because it reads orb:30min:high:* and nothing in the live engine writes it. In backtest the harness runs OrbDetector too, so this detector CAN fire here. Its results therefore answer a question the live engine could not: was it worth wiring up?',
			OPTION_ROUTED_CAVEAT,
		],
	},
]

// ── construction ───────────────────────────────────────────────────────────
// Kept separate from the metadata above so the metadata stays readable.
// Singletons ignore the symbol argument.
const CONSTRUCTORS: Record<string, (symbol: string) => IDetector> = {
	stock_momentum_breakout: (s) => new StockMomentumBreakoutDetector(s),
	nifty_opening_range_explosion: () => new NiftyOpeningRangeExplosionDetector(),
	nifty_trend_pulse: () => new NiftyTrendPulseDetector(),
	nifty_vwap_reclaim: () => new NiftyVwapReclaimDetector(),
	volatility_contraction: (s) => new VolatilityContraction(s),
	gap_and_go: (s) => new GapAndGoMomentum(s),
	oi_liquidity_sweep: () => new OiLiquiditySweepDetector(),
	delta_hedging_pressure: () => new DeltaHedgingPressureDetector(),
	orb: (s) => new OrbDetector(s),
	multi_timeframe_breakout: (s) => new MultiTimeframeBreakoutDetector(s),
	liquidity_sweep_sniper: () => new LiquiditySweepDetector(),
	order_flow_exhaustion: () => new OrderFlowExhaustionDetector(),
	smart_money_divergence: (s) => new SmartMoneyDivergenceDetector(s),
	vwap_stdev_reversion: (s) => new VwapStdevReversionDetector(s),
	vwap_pullback: () => new VwapPullbackDetector(),
	vwap_crossover: () => new VwapCrossoverDetector(),
	value_zone_scalp: () => new ValueZoneScalpDetector(),
	liquidity_trap: (s) => new LiquidityTrapDetector(s),
	nifty_options_scalper: () => new NiftyOptionsDetector(),
	morning_momentum: (s) => new MorningMomentumDetector(s),
	candle_breakout: (s) => new CandleBreakoutDetector(s),
	vcp: (s) => new VcpDetector(s),
	parabolic_rvol_sweep: (s) => new ParabolicRvolSweepDetector(s),
	volume_spike: (s) => new VolumeSpikeDetector(s),
	equity_liquidity_sweep: (s) => new EquityLiquiditySweepDetector(s),
	nifty_liquidity_sweep_v2: () => new NiftyLiquiditySweep(),
}

// Fail fast at import time if metadata and constructors drift apart.
for (const spec of REGISTRY) {
	if (!CONSTRUCTORS[spec.id]) {
		throw new Error(`[backtest/registry] no constructor registered for '${spec.id}'`)
	}
}
for (const id of Object.keys(CONSTRUCTORS)) {
	if (!REGISTRY.some((d) => d.id === id)) {
		throw new Error(`[backtest/registry] constructor '${id}' has no REGISTRY entry`)
	}
}

export const constructDetector = (id: string, symbol: string): IDetector => {
	const ctor = CONSTRUCTORS[id]
	if (!ctor) throw new Error(`[backtest/registry] unknown detector id '${id}'`)
	return ctor(symbol)
}

export const byId = (id: string): DetectorSpec => {
	const spec = REGISTRY.find((d) => d.id === id)
	if (!spec) throw new Error(`[backtest/registry] unknown detector id '${id}'`)
	return spec
}

export const backtestable = (): DetectorSpec[] => REGISTRY.filter((d) => d.backtestable)
export const notBacktestable = (): DetectorSpec[] => REGISTRY.filter((d) => !d.backtestable)

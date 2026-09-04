# Deprecated detectors

Archived on the `v2` branch, not hard-deleted. Nothing here is imported by the live engine
(`src/ingestion/websocket.ts`). Imports inside these files were re-pathed for the new depth so the
directory still lints and type-resolves — the code is intact and recoverable.

**Every detector in this directory is `UNTRACKED`**: the repo has never had a backtest, trade
journal, or outcome labelling, so none of these was removed on measured performance. They were
archived on structural grounds — dormant *and* mean-reversion-biased, or explicitly superseded.

## Tier A — dormant, mean-reversion or superseded (14)

| File | Reason |
|---|---|
| `Orderflowexhaustiondetector.ts` | mean-reversion (VWAP reversion after exhaustion) |
| `smartmoneydivergencedetector.ts` | mean-reversion (Wyckoff distribution/accumulation) |
| `vwapStdevReversionDetector.ts` | mean-reversion (±2.5σ band reversion) |
| `vwapPullbackDetector.ts` | mean-reversion (VWAP defense scalp) |
| `vwapCrossoverDetector.ts` | mean-reversion (VWAP crossover) |
| `valueZoneScalpDetector.ts` | mean-reversion (21-EMA pullback) |
| `liquidityTrapDetector.ts` | mean-reversion (wick rejection) |
| `niftyOptionsDetector.ts` | superseded by `v2/niftyTrendPulseDetector.ts` |
| `morningMomentumDetector.ts` | superseded by `StockMomentumBreakoutDetector` Setup A |
| `candleBreakoutDetector.ts` | superseded by `StockMomentumBreakoutDetector` Setup B |
| `vcpDetector.ts` | superseded by `v2/high_alpha/VolatilityContraction.ts` |
| `parabolicRvolSweepDetector.ts` | superseded by the v2 equity stack |
| `volumeSpikeDetector.ts` | superseded by the v2 equity stack |
| `equityLiquiditySweepDetector.ts` | superseded by the v2 equity stack |

## Tier C — dead code (1)

| File | Reason |
|---|---|
| `NiftyLiquiditySweep.ts` | Mean-reversion **and** could never fire: it reads `orb:30min:high:*`, a key written only by the dormant `orbDetector`. Archived rather than resurrecting that dependency. |

Removed from `src/detectors/v2/high_alpha/index.ts` and from the engine's imports, instantiation,
`analyze()` chain, and boot cleanup (`v2:state:nifty_sweep`, `v2:cooldown:nifty_sweep`).

## Deliberately NOT archived

- `src/detectors/orbDetector.ts` — dormant, but the **sole writer** of the `orb:15min:*` /
  `orb:30min:*` keys. Archiving it would cement a dead dependency for anything that reads them.
- `src/detectors/Multitimeframebreakoutdetector.ts` — dormant but momentum-biased; a candidate to
  revive rather than retire.
- `src/detectors/liquiditySweepDetector.ts` — dormant and structural, so it fell outside the
  approved Tier A set (which covered mean-reversion and superseded detectors only). Left in place
  pending a decision. It also depends on `orb:15min:*`.

## Reviving one

1. Move the file back to `src/detectors/`.
2. Revert its imports from `../../` to `../`.
3. Import and instantiate it in `src/ingestion/websocket.ts`, and add its Redis keys to the boot
   cleanup block there.
4. Add its regime class: pass `detectorName` **and** `regimeClass` on its `AlertPayload`, or it will
   fall back to fuzzy keyword matching on the trigger string. See `AGENTS.md` §3.8.

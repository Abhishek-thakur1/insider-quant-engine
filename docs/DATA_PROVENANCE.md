# DATA_PROVENANCE — which `paper_trades` rows are trustworthy

> Status: **started 2026-10-07, incomplete.** The full epoch table (flat `size: 100` era,
> pre-2026-09-14 sizing approximation, entry-date bucketing, etc.) is written in the docs step.
> This file currently records only the items below, each with its evidence.
> **Rule:** problem rows are *flagged*, never relabelled or overwritten to look clean.
> `scripts/fix_duration_class.ts` must not be used to hide a row.
>
> **2026-10-18:** flags now live in `paper_trades.data_quality TEXT[]` (migration `0002`), set by
> migration `0003` and at runtime by `positionTracker`. Flag vocabulary: AGENTS.md §14.

## Flagged rows

| Rows | Problem | Evidence | Safe for |
|---|---|---|---|
| *All three below* | After migration `0003`: `status = 'ORPHANED'`, flag `orphaned` (plus `capital_skipped` for the two size-0 rows, `duration_unverified` for all). Exit/PnL/R stay NULL. | `db/migrations/0003_flag_and_resolve_ghosts.sql` | as below |
| **SHAREINDIA SHORT**, Stock Momentum Breakout, entry ₹206.56, actual_size 1, still `OPEN`, `duration_class = SWING` | **Orphaned position** (no live process tracks it, so it can never close by SL/target/time). **The SWING label is probably not original.** Before `469a568` (2026-10-05 21:32) the worker never passed `durationClass`, so every row was inserted as `INTRADAY`. A row from before that date now reading `SWING` was most likely relabelled by `scripts/fix_duration_class.ts`, which overwrites in place and keeps no record. *Inferred from git history; there's no `updated_at` column to confirm it.* | `git log -S"durationClass: data.durationClass"` → first in `469a568`; script `5f96795` | Nothing until it is reconciled. Exclude from PnL, R-multiple and duration splits. |
| **ATLANTAELE LONG**, Volatility_Contraction_V2, entry ₹1880, actual_size 0, `OPEN` | Capital-skipped signal stored as an OPEN position, and orphaned (see below). PnL is ₹0 by construction. | `telegramWorker.ts:148` registers skips with actualSize 0; `positionTracker.ts:78` always inserts `'OPEN'` | Signal occurrence only. Never PnL. Outcome/R unknown (it never closed). |
| **RELIANCE LONG**, Volatility_Contraction_V2, entry ₹1189.9, actual_size 0, `OPEN` | Same as ATLANTAELE. | same | same |
| Row ids (EC2, migration `0003` applied 2026-10-18 12:53 UTC) | SHAREINDIA = **877, 885** (two SHORT rows on 2026-10-05). ATLANTAELE = **896**. RELIANCE = **890**. All 27 `ORPHANED` rows: 18 from the 2026-10-05 session (ids 854–907: 16 equities + 2 Nifty options, i.e. the session before 469a568's 3:15 auto-close) and 9 Nifty option rows, one or two per day on 2026-10-06…10-16 (908, 1080, 1090, 1161, 1164, 1241, 1365, 1538, 1582). Option rows never tick, so they can't close. They'll keep appearing (and get marked `ORPHANED` at the next boot) until expiry step 4 stops registering them. | `SELECT … WHERE status IN ('ORPHANED','SKIPPED')`, owner-run 2026-10-18 | — |

## Row counts after migration 0003 (EC2, 2026-10-18)

1,582 rows: 1,555 `CLOSED`, 27 `ORPHANED`, 0 `OPEN`, 0 `SKIPPED`. Rows can carry several flags, so the counts overlap.

| Flag | Rows | Note |
|---|---|---|
| *(none)* | 330 | Only CLOSED rows with no known problem. "No flag" means unflagged, not verified. |
| `capital_skipped` | 764 (749 CLOSED + 15 ORPHANED) | **About 48 % of CLOSED rows have `actual_size = 0`, so their ₹ PnL is 0 by construction.** After 2026-10-05 21:32 IST the split is 336 skipped vs 330 clean. The API's history/PnL endpoints still count them as CLOSED. |
| `synthetic_close` | 235 | Fake `EOD_EXPIRED` ₹0 / 0R closes from the removed boot sweep. |
| `duration_unverified` | 907 (889 CLOSED + 18 ORPHANED) | Entries before 469a568. |
| `pre_sizing_approx` | 76 | Entries before 2026-09-14. |
| `index_option_proxy` | 29 | Nifty CE/PE rows at index-level prices. |
| `orphaned` | 27 | See ids above. |

## Mechanisms that produce bad rows (apply to every row they touch)

| Mechanism | Since | Effect | Status / flag |
|---|---|---|---|
| Boot cleanup deletes Redis `trades:open` **after** `positionTracker.init()` loads it (`websocket.ts:128` then `:192`) | `c5f287b`, 2026-09-08 | A position that is still open at the start of its second session lives only in memory. The next boot finds nothing, so the Postgres row stays `OPEN` forever, with no exit, PnL or R. | **Fixed in code 2026-10-18** (boot no longer deletes `trades:open`; prior-day INTRADAY → `ORPHANED`). Existing rows: flag `orphaned`. Not yet deployed. |
| No engine-side force-close for INTRADAY positions | until `469a568`, 2026-10-05 (deploy date unconfirmed) | INTRADAY positions could stay open overnight and then be orphaned by the mechanism above | Code fixed; deployment unverified |
| `quant_api` boot migration closes prior-day `OPEN` rows at `exit_price = entry_price`, `realized_pnl = 0`, `r_multiple = 0`, `exit_reason = EOD_EXPIRED`, `exit_time = now()` | `f0d51fc`, 2026-09-24 | **Made-up outcome.** It records a ₹0 / 0R result that never happened, dated on the API restart day. SWING rows are included. | **Removed in code 2026-10-18** (versioned migrations; boot is read-only). Existing rows: flag `synthetic_close`. Safe to restart `quant_api` only once the new code is deployed. |
| Capital-skipped signals (`actual_size = 0`) inserted as `OPEN` positions | sizing feature, 2026-09-14 | Shown as active positions. PnL always ₹0. Their R is the only usable outcome (and only if they closed) | **Fixed in code 2026-10-18**: inserted as `SKIPPED`. Existing rows: flag `capital_skipped`. |
| `duration_class` stored as `INTRADAY` for every row | until `469a568` | Duration splits before that date mean nothing; later `SWING` labels on old rows may be script relabels | Open (can't be undone). Flag `duration_unverified`. |
| Nifty option-routed rows (`NIFTY <strike> CE/PE`) | — | Index-level prices; qty 0 (`floor(10000 / ~25000)`). Symbol never ticks, so they never close | Open (expiry fix, step 4). Flag `index_option_proxy`. |

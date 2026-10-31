# EV-reject shadow outcomes: design

**Status:** PR only, not deployed. It sends no alerts, changes no gate or threshold, and is **off by default**: `EV_SHADOW_ENABLED=true` turns it on.

## Purpose

When the EV hard gate rejects a fire, there is no alert and no paper trade, so nobody knows whether those fires would have won. This records a **simulated outcome** for each one, so that question can be measured.

## What is recorded

For each EV rejection (`decision.rejectedAt === 'EV'`) the engine records one row. Every rule matches the paper trade:

| | Rule | Same as the paper trade? |
|---|---|---|
| Levels | `computeTradeLevels(data)` (`src/core/tradeLevels.ts`). Equities: stop = VWAP × 0.998 / × 1.002, target = entry ± 1.5 × risk. Options: the SL/T1 in the trigger | Yes. The pipeline now calls the same function, moved out of `alertPipeline.ts` unchanged |
| Entry | the fire price, at the fire time | Yes |
| Exit | the first tick at or after 15:15 IST gives TIME (INTRADAY). Otherwise the tick price at or beyond the stop gives STOP_LOSS, and at or beyond the target gives TARGET, in that order | Yes. It is `positionTracker.processTick`'s rule, and a test runs both on the same ticks |
| R | (exit − entry) / (entry − stop), signed by side, to 4 dp; null if the denominator is 0 | Yes |
| **Nifty option fires** | evaluated on **`NSE:NIFTY50-INDEX` ticks**, because the levels are index-level and no option ticks are subscribed. Flagged `index_proxy` | **No.** A paper option trade can't close at all (it ends ORPHANED). This is the one deliberate difference |
| Bad geometry (stop on the wrong side of entry) | skipped and counted, no row | The paper trade records these flagged `invalid_geometry`; the shadow has no outcome to measure |

## DB change: a new table, migration `0007_ev_shadow_outcomes`

**A separate table, not a flag on `paper_trades`.** Every stat, API endpoint, dashboard total and study query reads `paper_trades` or `signals`. A table they don't know about **cannot leak into them**, whereas a flag would need a `WHERE` clause added to every query.

**Columns:**
- `signal_id`: joins to `signals`, with no FK because the signals row is written asynchronously;
- `trade_date`, `symbol`, `tracked_symbol`, `detector`, `direction`;
- `score`, `ev`;
- the levels;
- `status`: OPEN, CLOSED or UNRESOLVED;
- the exit fields, `r_multiple` and `data_quality`.

**Consequences:**
- The migration is additive and touches no existing table.
- **After it, a `pg_dump` holds 4 TABLE DATA entries, not 3.** The deploy gate must be updated.
- **No Redis keys:** open shadows are in memory, and a same-day restart reloads today's OPEN rows from the table. At boot, earlier days' OPEN rows become UNRESOLVED.

## Bounds (rate limit)

- **50 new rows a day.** For scale, EV rejects have been about one a day since 21 Oct.
- **20 open at once.** In-flight inserts count, so a burst can't overshoot.
- **One open per symbol + detector + side.**
- Every failure is swallowed and counted. A failed close leaves the row OPEN, and it becomes UNRESOLVED the next day.

## Isolation

- **The hook:** `PipelineDeps.onEvRejected`, called in the hard-gate rejection branch after the existing logging, just before `return`. It is synchronous fire-and-forget inside a `try`.
- **The tracker:** fed from the tick handler with `getEvShadow()?.onTick(...)`, never awaited.
- **Never touched:** `paper_trades`, `trades:open`, `trades:history`, `pnl:daily`, the alert-policy keys, Telegram.

## Tests (`tests/evShadow.test.ts`)

1. **IDENTICAL:** every worker scenario produces exactly the same effects with the shadow on and off:
   - filter calls, `registerTrade` (positions), Redis alert-policy operations;
   - Telegram sends, admin notices, console output.

   A shadow hook that throws changes nothing either.
2. **SAME RULES:** on the same tick paths, the shadow closes with the same exit price, time, reason and R as the real `positionTracker.processTick`. The paths cover LONG and SHORT, target and stop, and TIME at 15:15.
3. **SAME LEVELS:** the pipeline registers `computeTradeLevels`' numbers, for an equity and an option.
4. **Options:** tracked on Nifty index ticks and flagged `index_proxy`.
5. **Bounds:** the daily cap, the open limit including a burst, duplicates and bad geometry.
6. **Separate:** only `evShadow.ts` and the migration name the table.
7. **Off by default.**

## Deploy (Thu 29 Oct): code + migration, shadow ON (owner, 28 Oct)

Corrected after the independent review of 28 Oct. It follows the repo's migration order (AGENTS.md "Deploy order": `pg_dump` → rebuild → migrate dry-run → migrate → restart).

1. **Checks:** after 16:05, confirm the 15:35 log export, the 15:45 summary and the 16:00 backup finished. Then Telegram the owner.
2. **Logs:** copy the engine and API logs and their `docker inspect` output (a recreate deletes them).
3. **Backup:** fresh `pg_dump`; check it has **3** TABLE DATA entries (before the migration).
4. **Rollback tags:** engine `rollback-609755e` → `413505a5bffb`, API `rollback-5e95059` → `147035ad51c6`.
5. **Merge #41,** then `git pull` v2 on the server.
6. **Build `quant_engine` and `quant_api`.** The migration file only exists in the new image, and the migration runs through `quant_api`.
7. **Dry run:** `docker compose run --rm quant_api npm run migrate -- --dry-run`. It should list exactly `0007_ev_shadow_outcomes`.
8. **Migrate:** `docker compose run --rm quant_api npm run migrate`. Then check that `schema_migrations` has 0007, and that a new `pg_dump` now has **4** TABLE DATA entries (`ev_shadow_outcomes` is the 4th). From here on, the deploy gate expects 4.
9. **Turn the shadow on** (owner, 28 Oct): back up `.env` by name (`.env.bak-<date>`), add `EV_SHADOW_ENABLED=true`, and check that the line appears exactly once. Mask the value of every other line when showing it.
10. **Engine:** `docker compose up --no-start --no-deps --force-recreate quant_engine`, left Created. A recreate is what re-reads `.env`; the 09:00 cron starts it.
11. **API:** `docker compose up -d --no-deps quant_api`, then the health check on all 7 routes.
12. **Next boot (Fri 09:00):** it should log `[EvShadow] 🧪 ACTIVE — observation only · 0 open today reloaded · 0 recorded today · 0 earlier OPEN marked UNRESOLVED`, with no pending-migration warning. The 09:21 check-in confirms it.

**Rollback:** remove the `.env` line (or restore `.env.bak-<date>`) and recreate the engine; that turns the shadow off without touching the table. For the code itself, use the image tags above. The new table is inert while the flag is off. To remove it, restore the backup, or follow the reverse statement in the migration header.

## Turning it off or on again later

1. Set `EV_SHADOW_ENABLED=true` in `.env`.
2. **Recreate** `quant_engine`, after copying its logs. A plain restart doesn't re-read `.env`.

The boot log then shows `[EvShadow] 🧪 ACTIVE — observation only · … open today reloaded · … recorded today …`. If the database query at init fails or takes more than 5 s, the tracker logs a warning and stays inactive for the day; boot is never held up.

To read the results:

```sql
SELECT status, count(*), avg(r_multiple) FROM ev_shadow_outcomes GROUP BY 1;
```

**Reading the results:** they are descriptive. The `index_proxy` rows measure the index move against index-level levels, not option P&L.

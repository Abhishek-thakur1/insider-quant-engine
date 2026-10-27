# HANDOFF

The state of the deploy queue and what waits on the owner. **`AGENTS.md` is the source of truth for how the system works.** This file only tracks order and status. Update it in the same PR as any change to the queue.

Last updated: **2026-10-27, 20:50 IST**.

## Running on EC2

| Container | Code | Image | State |
|---|---|---|---|
| `quant_engine` | `v2` `5e95059` (PR #22 on top of #29) | `0231f64ab9ef` | Created; the 09:00 cron starts it. **Watchlist 51 stocks from 28 Oct** (52/100); backup `watchlist.json.bak-20261027-25` |
| `quant_api` | `v2` `5e95059` | `147035ad51c6` | running |

- **#29 deploy (26 Oct, evening):**
  - backup `~/backups/pre-orphanfix-20261026T1651Z.dump` (3 TABLE DATA entries);
  - rollback tag `insider-quant-engine-quant_engine:rollback-1b2ec34` → `5250090191c8`;
  - engine logs saved to `~/evidence/2026-10-26/engine_pre_recreate_29.log`.

## Deploy order (owner, 26 Oct)

**Rules for every deploy:**
- one change per evening, after 15:30 IST only;
- before deploying: an independent review in a separate worktree, then a Telegram message to the owner;
- then the full procedure:
  1. copy the logs;
  2. take a fresh `pg_dump` and check it has 3 TABLE DATA entries;
  3. record a rollback tag;
  4. rebuild only the changed container(s);
  5. leave the engine Created.

If any gate fails, or an earlier evening shows a problem: **stop, hold the rest, report.**

| Evening | Change | Containers | Status |
|---|---|---|---|
| Mon 26 Oct | PR #29: boot orphaning touches OPEN rows only | engine | **deployed** |
| Tue 27 Oct | Restore of the 6 originally-SKIPPED rows (owner OK, 27 Oct) | database only | **done, 19:58.** Backup `pre-restore-20261027T1427Z.dump`; exactly 6 rows ORPHANED → SKIPPED (ORPHANED 33 → 27, SKIPPED 1 → 7) |
| Tue 27 Oct | PR #22: duplicate-alert policy, plus the API | engine + API, one procedure | **deployed, 19:58–20:00:36** (actions log). All three checks passed. Merged as `5e95059` (= the reviewed `e46fe1f`). Backup `pre-dup22-20261027T1428Z.dump`; rollback tags `rollback-11dda4d` (engine) and `rollback-255adfd` (API); all 7 API routes 200 |
| Wed 28 Oct | PR #32: Nifty block diagnostics, logging only | engine | queued, **on the owner's go-ahead**, after 16:05 and the three checks. Independent review APPROVE (27 Oct, `51eda71`, after the fire-day parity fix) |
| **Tue 27 Oct, done** | PR #36 owner picks **plus #34's 22 rule names**, as one config-only change (owner, 27 Oct); live from 28 Oct, 52/100. PRs #34 and #36 merged as docs only (`fc192c4`, `30e7f52`) | watchlist file only | done | watchlist file only: edited after the 16:30 check, then the 09:00 cron starts the engine; no rebuild | queued; independent review APPROVE WITH NITS (27 Oct, nits fixed). Precondition: `quant_screener` stays absent |
| **Thu 29 Oct** | PR #41: EV-reject shadow outcomes, with migration 0007 | engine + migration | queued. `pg_dump` first; **after 0007 the backup check expects 4 TABLE DATA entries** (was 3). Off unless `EV_SHADOW_ENABLED=true` |
| After #41 | Wide coverage: RULE-85's extra 33 names (`docs/proposals/watchlist-50/RULE-85.md`, `LIST-85.md`) → 85/100 | watchlist file only | queued, on the owner's word; precondition: `quant_screener` stays absent |
| Later | PR #40: VWAP 09:15 cut-off (approved in principle) | engine | queued; the deploy date is a **series break** (record it in AGENTS §11.25, the CHANGELOG and the study's deviation log) |

**Evening timing:** from 27 Oct, deploys start no earlier than 16:05, after three things have finished: the 15:35 log export, the 15:45 summary and the 16:00 backup.

**Not yet in the queue, each needing the owner's word:**
- PR #42: screener narrowed to liquid F&O. Design only; **no Fyers call and no container recreate without the owner's explicit OK that evening** (50-request pilot first).
- PR #37: staleness message.
- PR #38: VWAP key TTL.
- PR #33: near-miss digest, a host script.

**Leave alone:**
- #31: do not merge or deploy.
- #28: leave open.
- #9: wait for the owner's word.

## Scheduled check-ins (owner, 27 Oct)

They are read-only. During market hours there are no restarts, deploys or merges. If the session restarted, re-create them with CronCreate (one-shot, PC local time is IST):

| When (IST) | Report |
|---|---|
| Wed 28 Oct 09:21 | the boot line (expect `52/100 … watchlist 51 + bench 0 + index 1 + options 0`), stocks seen out of 51, ticks per 5 minutes, engine CPU and memory (`docker stats`), errors in the log, the monitor's result, the first fire's position id |
| Wed 28 Oct 09:31 | the same, plus whether the watchdog restarted anything (container start time, restart counter) |
| Wed 28 Oct 15:47 | after the close: the 15:45 summary sent, the day's fires and alerts, paper trades, restarts, errors, the 15:35 export |

- **An early "fewer than 40 seen" monitor FAIL before 09:25:** compare it with the 09:25 status before calling it a failure. The first windows after the open can be sparse.
- **If the engine restarts by itself:** report how many Fyers calls the seeder made (the `[Seeder] ✅ Done …` line and the `fyers:quota` ledger). A restart during the session makes at most 53, paced at 4/s and 40/min.
- **Then Wed after 16:05:** #32, on the owner's go-ahead, after the three checks and my own backup.

## Waiting on the owner

- **The 15 older capital-skipped rows** (5–16 Oct): include them in the restore or not. The default is not.
- **The old `vwap:*` keys:** the cleanup proposal in PR #38 (`docs/proposals/vwap-key-cleanup.md`), not run.

## Never

- No deploys or restarts 09:00–15:30 IST.
- No Fyers REST calls without the owner's OK.
- No changes to gates, thresholds or detectors beyond what a reviewed PR contains.
- Never touch `main`.
- No history rewrite.
- No `docker system prune` or `docker volume prune`.

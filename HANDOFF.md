# HANDOFF

The state of the deploy queue and what waits on the owner. **`AGENTS.md` is the source of truth for how the system works.** This file only tracks order and status. Update it in the same PR as any change to the queue.

Last updated: **2026-10-28, 19:20 IST**.

## Running on EC2

| Container | Code | Image | State |
|---|---|---|---|
| `quant_engine` | `v2` `609755e` (PR #32 on top of #22, #29) | `413505a5bffb` | Created; the 09:00 cron starts it. Watchlist 51 stocks from 28 Oct (52/100); backup `watchlist.json.bak-20261027-25` |
| `quant_api` | `v2` `5e95059` (PR #22) | `147035ad51c6` | running |

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
| Tue 27 Oct | Restore of the 6 originally-SKIPPED rows | database only | **done** (19:58) |
| Tue 27 Oct | PR #22: duplicate-alert policy + API | engine + API | **deployed** (19:58–20:00:36) |
| Tue 27 Oct | Watchlist 25 → 51: owner picks (#36) + #34's 22 rule names | watchlist file only | **done**, live 28 Oct (52/100) |
| Wed 28 Oct | PR #32: Nifty "why no alert" diagnostics (logging only) | engine | **deployed** 18:42 (`609755e`, image `413505a5bffb`; rollback tag `rollback-5e95059`) |
| **Thu 29 Oct** | PR #41: EV-reject shadow outcomes + migration 0007 | engine + migration | after 16:05, the three checks + own `pg_dump`; **expect 4 TABLE DATA after the migration**; needs its independent review (running 28 Oct) |
| Fri 30 Oct at the earliest | PR #40: VWAP 09:15 cut-off (approved in principle) | engine | the deploy date is a **series break** (AGENTS §11.25, CHANGELOG, study deviation log) |
| After #40, on the owner's word | Wide coverage: RULE-85's extra 33 names → 85/100 | watchlist file only | precondition: `quant_screener` stays absent |

**Evening timing:** deploys start no earlier than 16:05, after the 15:35 log export, the 15:45 summary and the 16:00 backup have all finished. One change per evening. No merge of a code PR before its evening, and none in market hours.

## Open PRs (28 Oct, after the docs merges)

Merged today as docs/study only: #34 (`fc192c4`), #36 (`30e7f52`), #35 (`e669c57`), #42 (`4585edb`), and #39 (this file). Code, merged on its evening: #32 (`609755e`).

| PR | Title (short) | Type | Runtime effect if deployed | Evening / condition | Independent review | Status |
|---|---|---|---|---|---|---|
| #41 | EV-reject shadow outcomes | code + migration | new table `ev_shadow_outcomes`, hook on EV rejects; off unless `EV_SHADOW_ENABLED=true` | **Thu 29 Oct** | running (28 Oct, on `cf660b8` after merging v2) | open |
| #40 | VWAP 09:15 session gate | code | equity VWAP and the Nifty reference start at 09:15; kill switch | **Fri 30 Oct at the earliest** (series break) | none yet | open |
| #43 | 15:15 square-off by timer + per-symbol serialisation | code | TIME exits at the last known price from 15:15; no double close | **none assigned**; proposed after #40 (series break for TIME-exit prices) | none yet | open |
| #38 | 36 h TTL on `vwap:*` keys + cleanup proposal | code | daily VWAP keys expire | **none assigned**; proposed after #43 | none yet | open |
| #37 | Staleness message names the file in use | code (log text) | boot warning text only | **none assigned**; proposed with no other change, after #38 | none yet | open |
| #31 | Nifty ORE evaluates the lock candle | code (detector) | changes when ORE can fire | **hold** (owner: do not merge or deploy) | — | open |
| #33 | Near-miss digest in the 15:45 summary | host script | adds rejected fires to the 15:45 admin message (read-only SQL) | **none assigned**; owner's word (host script copy, no engine change) | none yet | open |
| #28 | Shadow candidates: pre-registration | docs/study only | none | owner said "leave open" (26 Oct); **propose merging as docs** on the owner's word | n/a | open |
| dashboard #9 | Today: alerted vs recorded-only | frontend | the dashboard's Today view splits alerted from rejected paper trades | **owner's word**; never merge `main` 09:00–15:30 | preview verified 23 Oct; no independent review | open |

**Superseded or unassigned:** nothing is superseded by a merged change. #43, #38, #37 and #33 have no evening yet; the proposed order is above. #28 and dashboard #9 wait for the owner's word. **No PR is proposed for closing.**

**Leave alone:** #31 (do not merge or deploy), #28 (until the owner's word), #9 (the owner's word).

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

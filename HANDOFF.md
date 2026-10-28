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
| **Thu 29 Oct** | PR #41: EV-reject shadow outcomes + migration 0007 (flag stays off) | engine + API (rebuild both; migration runs through `quant_api`) | after 16:05, the three checks + own `pg_dump` (3 TABLE DATA), migrate dry-run, migrate, then **4 TABLE DATA**. Independent review APPROVE WITH NITS (`27a5ae1`), nits fixed (`fedc64c`). Steps: `docs/proposals/ev-shadow/DESIGN.md` |
| **Fri 30 Oct** | PR #44: per-symbol `processTick` serialisation (bug fix: no double close) | engine | needs an independent review first |
| **Mon 2 Nov** | PR #40: VWAP 09:15 cut-off (approved in principle) | engine | **series break** (AGENTS §11.25, CHANGELOG, study deviation log); needs an independent review first |
| **Tue 3 Nov** | PR #45: 15:15 square-off by timer (builds on #44) | engine | **series break for time-exit prices** (AGENTS §11.30); needs an independent review first |
| **Wed 4 Nov** | PR #38 (VWAP key TTL) **+** PR #37 (staleness message), together (owner, 28 Oct) | engine | needs independent reviews first |
| Owner to confirm | PR #33: near-miss digest (top 10 by score + counts; approved) | host script copy, no engine change | owner said "evening after #41", but Fri has #44 and one change per evening stands: **Fri together with #44, or Thu 5 Nov?** |
| After the owner confirms the IAM policy | PR #46: S3 backup fix | `quant_scheduler` only | then the leftover cleanup (dry-run list first; 23 empty dirs on 28 Oct) |
| On the owner's word | Wide coverage: RULE-85's extra 33 names → 85/100 | watchlist file only | precondition: `quant_screener` stays absent |

**Evening timing:** deploys start no earlier than 16:05, after the 15:35 log export, the 15:45 summary and the 16:00 backup have all finished. One change per evening. No merge of a code PR before its evening, and none in market hours.

## Open PRs (28 Oct, evening)

Merged as docs/study only: #34, #36 (27 Oct); #35, #42, #39, #28 (28 Oct). Code merged on its evening: #29, #22, #32. Closed: #43, split by the owner into #44 + #45.

| PR | Title (short) | Type | Runtime effect if deployed | Evening / condition | Independent review | Status |
|---|---|---|---|---|---|---|
| #41 | EV-reject shadow outcomes | code + migration | new table `ev_shadow_outcomes`; off unless `EV_SHADOW_ENABLED=true` | **Thu 29 Oct** | APPROVE WITH NITS, nits fixed | open |
| #44 | `processTick` serialised per symbol | code (bug fix) | removes the double close of one position by overlapping ticks | **Fri 30 Oct** | to do | open |
| #40 | VWAP 09:15 session gate | code | equity VWAP and the Nifty reference start at 09:15; kill switch | **Mon 2 Nov** (series break) | to do | open |
| #45 | 15:15 square-off by timer | code | TIME exits at the last known price from 15:15; kill switch | **Tue 3 Nov** (series break) | to do | open |
| #38 | 36 h TTL on `vwap:*` keys | code | daily VWAP keys expire | **Wed 4 Nov**, with #37 | to do | open |
| #37 | Staleness message names the file in use | code (log text) | boot warning text only | **Wed 4 Nov**, with #38 | to do | open |
| #33 | Near-miss digest (top 10 by score) | host script | 15:45 admin message lists rejected fires | approved; **evening to confirm** | to do | open |
| #46 | S3 backup fix + leftover cleanup | scheduler | dump to `/var/backups/iqe`, S3 upload with region, alert on failure | after the owner applies the IAM policy | to do | open |
| #31 | Nifty ORE evaluates the lock candle | code (detector) | changes when ORE can fire | **hold** | — | open |
| dashboard #9 | Today: alerted vs recorded-only | frontend | Today view split | owner's word; never merge `main` 09:00–15:30 | preview verified 23 Oct | open |

**Reviews:** each independent review runs in its **own clone** (`git clone --shared`), not a worktree of this repo. Worktrees share one `.git`, so a reviewer's git commands could collide with mine ("another command ran in this repository at the same time", owner, 28 Oct).

**Parked study (owner, 28 Oct; no change to anything):** alerts cluster (6 in 25 minutes on 28 Oct). Measure how correlated simultaneous alerts are, and what a per-window cap would have done on the history.

## Scheduled check-ins (owner, 27 Oct)

They are read-only. During market hours there are no restarts, deploys or merges. If the session restarted, re-create them with CronCreate (one-shot, PC local time is IST):

| When (IST) | Report |
|---|---|
| Every trading day 09:21 | the boot line (expect `52/100 … watchlist 51 + bench 0 + index 1 + options 0`), stocks seen out of 51, ticks per 5 minutes, engine CPU and memory (`docker stats`), errors in the log, the monitor's result, the first fire's position id |
| Every trading day 09:31 | the same, plus whether the watchdog restarted anything (container start time, restart counter) |
| Every trading day 15:47 | after the close: the 15:45 summary sent, the day's fires and alerts, paper trades, restarts, errors, the 15:35 export |

- **An early "fewer than 40 seen" monitor FAIL before 09:25:** compare it with the 09:25 status before calling it a failure. The first windows after the open can be sparse.
- **If the engine restarts by itself:** report how many Fyers calls the seeder made (the `[Seeder] ✅ Done …` line and the `fyers:quota` ledger). A restart during the session makes at most 53, paced at 4/s and 40/min.
- **The PC must stay awake.** On 28 Oct the PC slept and all three check-ins fired at about 18:32. Before each session, re-create them for that date (CronCreate one-shot; PC local time is IST).

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

# HANDOFF

The state of the deploy queue and what waits on the owner. **`AGENTS.md` is the source of truth for how the system works.** This file only tracks order and status. Update it in the same PR as any change to the queue.

Last updated: **2026-10-29, 22:20 IST**.

## Running on EC2

| Container | Code | Image | State |
|---|---|---|---|
| `quant_engine` | `v2` `825726c` (PR #41 on top of #32, #22, #29); `EV_SHADOW_ENABLED=true` | `c751a03b8678` | Created; the 09:00 cron starts it. First boot with the EV shadow: Fri 30 Oct. Watchlist **52 stocks from 29 Oct (53/100)**: the 51 from 28 Oct + `NSE:JPL-EQ` (group `new_listing`); backups `watchlist.json.bak-20261027-25`, `watchlist.json.bak-20261028-prejpl` |
| `quant_api` | `v2` `825726c` (PR #41) | `fb075db5737c` | running; 7/7 routes 200 after the 29 Oct deploy |
| `quant_scheduler` | `v2` `45236ee` (PR #46) | `48819ab8155f` | running; 16:00 dump to `/var/backups/iqe` + S3 (first upload ever: 29 Oct 22:03, verified) |

- **#29 deploy (26 Oct, evening):**
  - backup `~/backups/pre-orphanfix-20261026T1651Z.dump` (3 TABLE DATA entries);
  - rollback tag `insider-quant-engine-quant_engine:rollback-1b2ec34` → `5250090191c8`;
  - engine logs saved to `~/evidence/2026-10-26/engine_pre_recreate_29.log`.

## Deploy order (owner, 26 Oct; this week's schedule replaced by the owner on 28 Oct)

**Gates for every deploy (unchanged):**
- the server clock shows it's outside market hours, and on a trading day after 16:05 (Saturday: market closed);
- the PR's independent review has passed (run in its own clone);
- the three checks: the 15:35 log export, the 15:45 summary and the 16:00 backup finished (on trading days);
- a Telegram message to the owner first;
- then the full procedure:
  1. copy the logs;
  2. take a fresh `pg_dump` and check its TABLE DATA count (3, or **4 after migration 0007**);
  3. record a rollback tag;
  4. rebuild only the changed container(s);
  5. leave the engine Created.

**Relaxed for 29–31 Oct only (owner, 28 Oct):** "one change per evening" no longer applies; the evenings below carry several changes.
- **Each change gets its own backup and rollback tag,** deployed one after another, so each can be rolled back on its own.
- **Report after each deploy.**
- **If any gate fails or a review finds a blocker:** stop. Don't move the failed change onto another evening without telling the owner.

**Pre-authorization:** otherwise as written.

| Evening | Change | Containers | Status |
|---|---|---|---|
| Mon 26 Oct | PR #29: boot orphaning touches OPEN rows only | engine | **deployed** |
| Tue 27 Oct | Restore of the 6 originally-SKIPPED rows | database only | **done** (19:58) |
| Tue 27 Oct | PR #22: duplicate-alert policy + API | engine + API | **deployed** (19:58–20:00:36) |
| Tue 27 Oct | Watchlist 25 → 51: owner picks (#36) + #34's 22 rule names | watchlist file only | **done**, live 28 Oct (52/100) |
| Wed 28 Oct | PR #32: Nifty "why no alert" diagnostics (logging only) | engine | **deployed** 18:42 (`609755e`, image `413505a5bffb`; rollback tag `rollback-5e95059`) |
| Wed 28 Oct | New listing `NSE:JPL-EQ` (Jio Platforms), group `new_listing`, 51 → 52 (AGENTS §11.27.1) | watchlist file only | **done** 22:00, live 29 Oct (53/100) |
| Thu 29 Oct | PR #41: EV-reject shadow outcomes + migration 0007, **shadow ON** | engine + API | **deployed** 21:57–22:00 (`825726c`; engine `c751a03b8678` Created, API `fb075db5737c`). 0007 applied, dump **4 TABLE DATA**. `.env.bak-20261029-pre41`. Rollback tags `rollback-609755e` (engine), `rollback-5e95059` (API). Backups `pre-evshadow41-20261029T1627Z.dump` (3), `post-0007-20261029T1628Z.dump` (4) |
| Thu 29 Oct | PR #46: S3 backup fix | `quant_scheduler` only | **deployed** 22:02 (`45236ee`, image `48819ab8155f`; rollback tag `rollback-pre46` → `48ed31bfd5fb`). Manual run: dump 4 TABLE DATA, **S3 upload verified**. The scheduler `/tmp` held 7 old dumps: copied to `~/backups/scheduler-tmp-pre46/` before the recreate. **Leftover cleanup done** (owner OK, 22:06): `rmdir` of exactly 24 empty `/tmp/paper_trades_*.sql` dirs, 0 failed; list in `~/evidence/2026-10-29/cleanup_removed_24.txt`. The 7 saved old dumps were uploaded once to the S3 prefix (sizes match; prefix holds 8) |
| **Fri 30 Oct** | PR #44: per-symbol `processTick` serialisation (bug fix) | engine | own backup + tag |
| **Fri 30 Oct** | PR #33: near-miss digest (top 10 by score + counts) | host script copy only (no engine change) | only if it is still host-script-only at deploy |
| **Fri 30 Oct** | PR #38: VWAP key TTL | engine | own backup + tag |
| **Fri 30 Oct** | PR #37: staleness message (log text) | engine | own backup + tag |
| **Sat 31 Oct** (market closed) | PR #40 (VWAP 09:15 cut-off) **+** PR #45 (15:15 timer exit) | engine | **ONE series break, dated 31 Oct** (first session Mon 2 Nov) in AGENTS.md, CHANGELOG, HANDOFF and the study's deviation log. Merge v2 into #45 first: keep both lines after `positionTracker.init()` (timer start and evShadow init) |
| On the owner's word | Wide coverage: RULE-85's extra 33 names → 85/100 | watchlist file only | precondition: `quant_screener` stays absent |

**Evening timing:** deploys start no earlier than 16:05 on trading days, after the 15:35 log export, the 15:45 summary and the 16:00 backup have all finished. No merge of a code PR before its evening, and none in market hours.

**Independent reviews (each in its own clone, 28 Oct): all passed, with no blocker.** #44 APPROVE. #40, #45, #38, #37, #33 and #46 APPROVE WITH NITS, all nits fixed and pushed. #41 was approved earlier.

**Pre-check (28 Oct):** all eight PRs (#41, #46, #44, #33, #38, #37, #40, #45) merged together in deploy order give 394/394 tests, typecheck 0, lint 20. There is one code conflict, the #41/#45 `websocket.ts` line above.

## Open PRs (28 Oct, evening)

Merged as docs/study only: #34, #36 (27 Oct); #35, #42, #39, #28 (28 Oct). Code merged on its evening: #29, #22, #32, #41, #46 (29 Oct). Docs: #47-#50. Closed: #43, split by the owner into #44 + #45.

| PR | Title (short) | Type | Runtime effect if deployed | Evening / condition | Independent review | Status |
|---|---|---|---|---|---|---|
| #44 | `processTick` serialised per symbol | code (bug fix) | removes the double close of one position by overlapping ticks | **Fri 30 Oct** | APPROVE (28 Oct) | open |
| #40 | VWAP 09:15 session gate | code | equity VWAP and the Nifty reference start at 09:15; kill switch | **Sat 31 Oct**, with #45 (one series break) | APPROVE WITH NITS (28 Oct), nits fixed `7fda9d0` | open |
| #45 | 15:15 square-off by timer | code | TIME exits at the last known price from 15:15; kill switch | **Sat 31 Oct**, with #40 (one series break) | APPROVE WITH NITS (28 Oct), fixed `c315780` (15:15–15:30 window, 120 s max price age, stopped on shutdown) | open |
| #38 | 36 h TTL on `vwap:*` keys | code | daily VWAP keys expire | **Fri 30 Oct** | APPROVE WITH NITS (28 Oct), fixed `ac60834` | open |
| #37 | Staleness message names the file in use | code (log text) | boot warning text only | **Fri 30 Oct** | APPROVE WITH NITS (28 Oct), fixed `124c9a2` | open |
| #33 | Near-miss digest (top 10 by score) | host script | 15:45 admin message lists rejected fires | **Fri 30 Oct** (host script only) | APPROVE WITH NITS (28 Oct), fixed `5b12ab0` | open |
| #31 | Nifty ORE evaluates the lock candle | code (detector) | changes when ORE can fire | **hold** | — | open |
| #52 | `.gitattributes` (LF line endings) | repo config | none at runtime; diff 1 file, +14 lines (renormalize changes nothing) | owner decision | — | open, not merged |
| dashboard #9 | Today: alerted vs recorded-only | frontend | Today view split | owner's word; never merge `main` 09:00–15:30 | preview verified 23 Oct | open |

**Reviews:** each independent review runs in its **own clone** (`git clone --shared`), not a worktree of this repo. Worktrees share one `.git`, so a reviewer's git commands could collide with mine ("another command ran in this repository at the same time", owner, 28 Oct).

**Parked study (owner, 28 Oct; no change to anything):** alerts cluster (6 in 25 minutes on 28 Oct). Measure how correlated simultaneous alerts are, and what a per-window cap would have done on the history.

## Scheduled check-ins (owner, 27 Oct)

They are read-only. During market hours there are no restarts, deploys or merges. If the session restarted, re-create them with CronCreate (one-shot, PC local time is IST):

| When (IST) | Report |
|---|---|
| Every trading day 09:21 | from 30 Oct: `[EvShadow] 🧪 ACTIVE` at boot and no pending-migration warning; the boot line (from 29 Oct expect `53/100 … watchlist 52 + bench 0 + index 1 + options 0`), any subscription error, whether `NSE:JPL-EQ` ticked and how many fires it produced (reported apart from the other groups), stocks seen out of 52, ticks per 5 minutes, engine CPU and memory (`docker stats`), errors in the log, the monitor's result, the first fire's position id |
| Every trading day 09:31 | the same, plus whether the watchdog restarted anything (container start time, restart counter) |
| Every trading day 15:47 | after the close: the 15:45 summary sent, the day's fires and alerts, paper trades, restarts, errors, the 15:35 export |

- **An early "fewer than 40 seen" monitor FAIL before 09:25:** compare it with the 09:25 status before calling it a failure. The first windows after the open can be sparse.
- **If the engine restarts by itself:** report how many Fyers calls the seeder made (the `[Seeder] ✅ Done …` line and the `fyers:quota` ledger). A restart during the session makes at most 54 (from 29 Oct), paced at 4/s and 40/min.

## New listing `NSE:JPL-EQ`: known limits (owner, 28 Oct)

Group `new_listing`, added 28 Oct (listing day), first session 29 Oct. See AGENTS.md §11.27.1.
- **About 2 days of history:** ATR, ADR and the trend gate are not meaningful for it.
- **Unusual first-days volatility and listing price bands.**
- **The 0.2% VWAP stop** is likely to be hit often.
- **Its paper trades are analysed separately.** It is never pooled with the other groups.
- **Depends on `quant_screener` staying absent:** that job would rewrite the file and drop it.
- **Rollback:** before 09:00 copy back `watchlist.json.bak-20261028-prejpl`. After 09:00, report only.
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

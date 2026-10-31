# HANDOFF

The state of the deploy queue and what waits on the owner. **`AGENTS.md` is the source of truth for how the system works.** This file only tracks order and status. Update it in the same PR as any change to the queue.

Last updated: **2026-10-31, 20:40 IST**.

## Running on EC2

| Container | Code | Image | State |
|---|---|---|---|
| `quant_engine` | `v2` `696ad65` (#41, #44, #38, #37, #40, #45 on top of #32, #22, #29); `EV_SHADOW_ENABLED=true` | `afe0c959e652` | Created; the 09:00 cron starts it. **First session with #44/#38/#37/#40/#45: Mon 2 Nov.** Watchlist 52 stocks (53/100) incl. `NSE:JPL-EQ` (group `new_listing`) |
| `quant_api` | `v2` `825726c` (PR #41) | `fb075db5737c` | running; 7/7 routes 200 after the 29 Oct deploy |
| `quant_scheduler` | `v2` `45236ee` (PR #46) | `48819ab8155f` | running; 16:00 dump to `/var/backups/iqe` + S3 (verified on schedule 30 Oct: 142,185 B, sizes match) |

- **#29 deploy (26 Oct, evening):**
  - backup `~/backups/pre-orphanfix-20261026T1651Z.dump` (3 TABLE DATA entries);
  - rollback tag `insider-quant-engine-quant_engine:rollback-1b2ec34` → `5250090191c8`;
  - engine logs saved to `~/evidence/2026-10-26/engine_pre_recreate_29.log`.

## Rollback card (first session Mon 2 Nov; read before 09:00)

The engine runs v2 `696ad65`, image `afe0c959e652`, also tagged `deployed-696ad65` for rolling forward. **Every action here recreates the engine, so it is allowed only outside 09:00–15:30 IST** (before about 08:55, or after 15:35). In market hours: report only. Before any of it: copy the logs and Telegram the owner.

```bash
cd ~/insider-quant-engine
docker logs quant_engine > ~/evidence/$(TZ=Asia/Kolkata date +%F)/engine_pre_rollback.log 2>&1
~/evidence/monitor/send_note.sh "Rolling back <what>, engine only, outside market hours."
```

| PR | Change | Kill switch (turns off this change alone) | Image rollback tag (cumulative, see below) | Lasting revert on v2 |
|---|---|---|---|---|
| #45 | 15:15 TIME exit by timer | `SQUARE_OFF_TIMER=false` | `rollback-5a4a78a` → `462afa35612d` | `git revert -m 1 696ad65` |
| #40 | VWAP from 09:15 | `VWAP_SESSION_GATE=false` | `rollback-0845761` → `bbfe21291ad4` (also removes #45) | `git revert -m 1 5a4a78a` |
| #37 | boot staleness message (log text) | none | `rollback-cfcb734` → `e282ddba76c2` (also removes #40, #45) | `git revert -m 1 0845761` |
| #38 | 36 h TTL on `vwap:*` keys | none | `rollback-e66a199` → `4a447d238047` (also removes #37, #40, #45) | `git revert -m 1 cfcb734` |
| #44 | per-symbol tick serialisation | none | `rollback-45236ee` → `c751a03b8678` (removes all five; #41 stays) | `git revert -m 1 e66a199`, **only together with #45**, which is built on it |

**A. Kill switch: one change only, no rebuild (#40, #45).**
```bash
cp -p .env .env.bak-$(date +%Y%m%d-%H%M)
echo 'SQUARE_OFF_TIMER=false' >> .env        # #45; or: echo 'VWAP_SESSION_GATE=false' >> .env   # #40
docker compose up --no-start --no-deps --no-build --force-recreate quant_engine   # a recreate re-reads .env; stays Created, the 09:00 cron starts it
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' quant_engine | grep -E '^(SQUARE_OFF_TIMER|VWAP_SESSION_GATE|EV_SHADOW_ENABLED)='
```
Undo: delete that line from `.env` (or restore the `.env.bak-…`), then run the same recreate.

**B. Image rollback (#37, #38, #44, or several).** The tags are cumulative: each one is the image from *before* that PR, so it also removes every PR deployed after it (the table says which). Pick the tag, then:
```bash
docker tag insider-quant-engine-quant_engine:rollback-5a4a78a insider-quant-engine-quant_engine:latest   # example: before #45
docker compose up --no-start --no-deps --no-build --force-recreate quant_engine
docker inspect -f '{{.State.Status}} {{.Image}}' quant_engine        # expect: created sha256:462afa35612d…
```
Roll forward: `docker tag insider-quant-engine-quant_engine:deployed-696ad65 insider-quant-engine-quant_engine:latest`, then the same recreate.

**Make it last:** the next `docker compose build` rebuilds from v2 and brings the change back. For a lasting rollback, open a PR on v2 with the revert from the table, and merge it on an evening.

**Not engine:** #33 digest: `cp -p ~/evidence/monitor/check.sh.bak-20261031-pre33 ~/evidence/monitor/check.sh`, no restart. #41 EV shadow: delete `EV_SHADOW_ENABLED=true` from `.env`, then recreate as in A.

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
| Sat 31 Oct (moved from Fri; owner OK) | PR #44: per-symbol `processTick` serialisation | engine | **deployed** 19:04 (`e66a199`, image `4a447d238047`; rollback tag `rollback-45236ee` → `c751a03b8678`; backup `pre-44-20261031T1332Z.dump`, 4 TABLE DATA) |
| Sat 31 Oct (moved from Fri) | PR #33: near-miss digest | host script + `check.sh` hook | **deployed** 19:06: script == v2 `a28d57c`; hook after the summary line; backup `check.sh.bak-20261031-pre33`; dump `pre-33-20261031T1335Z.dump`. First digest Mon 2 Nov 15:45 |
| Sat 31 Oct (moved from Fri) | PR #38: VWAP key TTL | engine | **deployed** 19:08 (`cfcb734`, image `e282ddba76c2`; `rollback-e66a199` → `4a447d238047`; `pre-38-20261031T1337Z.dump`) |
| Sat 31 Oct (moved from Fri) | PR #37: staleness message | engine | **deployed** 19:10 (`0845761`, image `bbfe21291ad4`; `rollback-cfcb734` → `e282ddba76c2`; `pre-37-20261031T1339Z.dump`) |
| **Sat 31 Oct** | PR #40 (VWAP 09:15) **+** PR #45 (15:15 timer exit): **ONE series break, dated 2026-10-31**, first session Mon 2 Nov | engine | **deployed** #40 19:13 (`5a4a78a`, image `462afa35612d`; `rollback-0845761` → `bbfe21291ad4`; `pre-40-20261031T1342Z.dump`), then #45 19:17 (`696ad65`, image `afe0c959e652`; `rollback-5a4a78a` → `462afa35612d`; `pre-45-20261031T1346Z.dump`). Recorded in AGENTS §11.25/§11.30, CHANGELOG and the study (deviation 15) |
| On the owner's word | Wide coverage: RULE-85's extra 33 names → 85/100 | watchlist file only | precondition: `quant_screener` stays absent |

**Evening timing:** deploys start no earlier than 16:05 on trading days, after the 15:35 log export, the 15:45 summary and the 16:00 backup have all finished. No merge of a code PR before its evening, and none in market hours.

**Why Friday moved:** the 15:47 check-in on Fri 30 Oct only fired on Sat 31 Oct 18:58 (the PC was asleep). Friday's gates had all passed; nothing was deployed on Friday. The owner approved running Friday's four and #40 + #45 on Saturday, in order, each with its own backup and tag.

**Independent reviews (each in its own clone, 28 Oct): all passed, with no blocker.** #44 APPROVE. #40, #45, #38, #37, #33 and #46 APPROVE WITH NITS, all nits fixed and pushed. #41 was approved earlier.

**Pre-check (28 Oct):** all eight PRs (#41, #46, #44, #33, #38, #37, #40, #45) merged together in deploy order give 394/394 tests, typecheck 0, lint 20. There is one code conflict, the #41/#45 `websocket.ts` line above.

## Open PRs (31 Oct, evening)

Merged as docs/study only: #34, #36 (27 Oct); #35, #42, #39, #28 (28 Oct). Code merged on its evening: #29, #22, #32, #41, #46 (29 Oct); #44, #33, #38, #37, #40, #45 (31 Oct). Repo config: #52 `.gitattributes` (31 Oct). Docs: #47-#51, #53-#55. Dashboard: #9 (31 Oct, `49a0f80`; rollback `git revert -m 1 49a0f80`). Closed: #43, split by the owner into #44 + #45.

| PR | Title (short) | Type | Runtime effect if deployed | Evening / condition | Independent review | Status |
|---|---|---|---|---|---|---|
| #31 | Nifty ORE evaluates the lock candle | code (detector) | changes when ORE can fire | **hold**; suggested: review Mon/Tue evening, deploy Wed 4 Nov after two clean sessions | — | open |
| #56 | Mobile backend readiness audit | docs | none | owner review; **do not merge** before | — | open |
| #57 | `/api/trades/history` 400 on a bad date | code (API only) | bad dates get 400, not a 500 with DB text | **Thu 5 Nov evening** (owner, 31 Oct), `quant_api` only; not before | — | open, not merged |
| #58 | Redis host port bound to 127.0.0.1 | compose (Redis) | Redis no longer listens on public interfaces | **Tue 3 Nov evening only, if Mon 2 Nov was clean** (owner, 31 Oct): after 16:05 and the three checks; Redis snapshot first; recreate `quant_redis` only; verify API health that evening and the engine's next boot (Wed 09:00); rollback in the PR | — | open, not merged |
| dashboard #10 | Stats exclude flagged rows (toggle) | frontend | stat cards/curve leave out flagged rows by default | **Mon 2 Nov evening, after 15:30** (owner, 31 Oct), once the preview checks pass; same checks as dashboard #9 (preview, then production on all three projects); not before | — | open, not merged |

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

## Mobile backend decisions (owner, 31 Oct; from the audit, PR #56)

1. **HTTPS entry:** the existing Vercel route + read-only per-device tokens. The API-only subdomain (report in `docs/mobile-backend-readiness/HTTPS_SUBDOMAIN.md`, PR #56: feasible without touching the Fyers redirect) is **parked** (owner, 31 Oct): no domain, DNS or firewall work.
2. **Auth:** per-device tokens.
3. **Distribution:** Play **internal testing only**.
4. **Push:** FCM direct, later.
5. **Default content:** alerted only; recorded-only behind a toggle.
6. **History:** from 2026-10-21, flagged rows excluded by default, `includeFlagged` toggle.
7. **Restore test:** yes, in a **throwaway container** with a memory cap, on an evening after 16:05, never inside the live Postgres; recorded in `docs/RUNBOOK.md` (procedure there). Planned for Mon 2 Nov evening (non-engine).
8. **Git history:** leave it; no Fyers secret rotation now.

**Evening rules:** freeze and one change per evening. **No engine change on Mon 2 Nov** (first session with five engine changes).

**Schedule (owner, 31 Oct):**

| Evening | Item | Condition |
|---|---|---|
| Mon 2 Nov, after 15:30 | dashboard #10 merge + deploy (frontend only) | preview checks pass; then production checks on all three projects |
| Mon 2 Nov, after 16:05 | restore test in a throwaway container (256 MB cap, `--network none`) | the three gates; result in `docs/RUNBOOK.md` |
| Tue 3 Nov, after 16:05 | #58 Redis bound to 127.0.0.1 | Monday clean; the three gates; snapshot first; `quant_redis` only |
| Thu 5 Nov evening | #57 API date validation | `quant_api` only |

#31 stays as in the table above.

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

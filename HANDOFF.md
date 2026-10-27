# HANDOFF

The state of the deploy queue and what waits on the owner. **`AGENTS.md` is the source of truth for how the system works.** This file only tracks order and status. Update it in the same PR as any change to the queue.

Last updated: **2026-10-27, 06:15 IST**.

## Running on EC2

| Container | Code | Image | State |
|---|---|---|---|
| `quant_engine` | `v2` `11dda4d` (PR #29) | `b23c6f864696` | Created; the 09:00 cron starts it |
| `quant_api` | `v2` `255adfd` (PR #24) | `2138a8191f64` | running |

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
| Tue 27 Oct | PR #22: duplicate-alert policy, plus the API | engine + API, one procedure | waiting for the evening |
| Wed 28 Oct | PR #32: Nifty block diagnostics, logging only | engine | queued |
| Thu 29 Oct | PR #36: owner picks (watchlist 29, 30/100), on its own evening | watchlist file + engine restart | queued; **needs an independent review of #36 first** |

**Not yet in the queue, each needing the owner's word:**
- PR #34: watchlist rule list, 22 names added, no backfill. Goes after #22.
- PR #37: staleness message.
- PR #38: VWAP key TTL.
- The VWAP session-gate PR.
- PR #33: near-miss digest, a host script.

**Leave alone:**
- #31: do not merge or deploy.
- #28: leave open.
- #9: wait for the owner's word.

## Waiting on the owner

- **Restore of the 6 originally-SKIPPED rows** (1583, 1585, 1590, 1596, 1599, 1603: ORPHANED → SKIPPED). The exact statement was sent on 26 Oct. **Not run.**
- **The 15 older capital-skipped rows** (5–16 Oct): include them in the restore or not. The default is not.
- **The old `vwap:*` keys:** the cleanup proposal in PR #38 (`docs/proposals/vwap-key-cleanup.md`), not run.
- **VWAP session gate:** decide after seeing the measured effect.

## Never

- No deploys or restarts 09:00–15:30 IST.
- No Fyers REST calls without the owner's OK.
- No changes to gates, thresholds or detectors beyond what a reviewed PR contains.
- Never touch `main`.
- No history rewrite.
- No `docker system prune` or `docker volume prune`.

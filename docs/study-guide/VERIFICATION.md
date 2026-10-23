# Study guide: verification log

- **Checked:** 23 Oct 2026, against `origin/v2` at `2fcbe9e`, open PR branches, the production host (read-only) and the production database (read-only).
- **Scope:** `docs/study-guide/guide.md`.

## File paths (51 referenced)
- **36** exist on `v2` at exactly the path given.
- **11** are short names for files on `v2`:
  - `alertPipeline.ts` → `src/workers/alertPipeline.ts`
  - `positionTracker.ts` → `src/core/positionTracker.ts`
  - `quota.ts` → `src/fyers/quota.ts`
  - `subscriptionPlan.ts` → `src/core/subscriptionPlan.ts`
  - `websocket.ts` → `src/ingestion/websocket.ts`
  - `VolatilityContraction.ts` → `src/detectors/v2/high_alpha/…`
  - `niftyOpeningRangeExplosionDetector.ts` → `src/detectors/v2/…`
  - `niftyVwapReclaimDetector.ts` → `src/detectors/v2/…`
  - `db_backup.sh` → `scheduler/…`
  - `trading_day.sh` → `scheduler/…`
  - `SUMMARY.md` → `backtest/studies/nifty-ema-trend/…`
- **2** are in the dashboard repo (`origin/main`): `src/App.tsx` and `vercel.json`.
- **2** are on branches the guide labels as not merged:
  - `scripts/ops/realRedisClaims.ts` (PR #22);
  - `docs/dashboard-redesign/AUDIT.md` (this docs branch).

## Numbers and claims
| Claim | Source | Status |
|---|---|---|
| 21 fires and 3 alerts on 22 Oct | `select count(*), sum(alert_sent) from signals where trade_date='2026-10-22'` → 21, 3 | ✅ |
| AEQUS 11:06: entry 245.70, stop 242.62, target 250.32, exit 242.55 at 12:17:24, −1.02R, −₹126, scores 85 and 88, H 1.16, P 0.68 and 0.81, EV 2.36 and 3.90 | `paper_trades` ids 1592 and 1593, `signals` rows | ✅ |
| AEQUS detector stops ₹242.14 and ₹241.76, VWAP ₹243.10 | `signals.trigger_sl`, trigger text | ✅ |
| JSLL 14:13: score 85, H 0.29, stop 356.54, target 340.06, exit 349.95 TIME 0.00R | `signals`, `paper_trades` id 1598 | ✅ |
| 2,189 symbols subscribed (old build) | `~/evidence/2026-10-21/engine.log`: `All 2189 symbols subscribed across 11 chunks`. Another boot that day shows 2,159. | ✅ (two values; the guide uses 2,189) |
| 25/25 stocks seen, `eq→router 2705` after the 26-symbol deploy | project memory, from the host log of 21 Oct | ✅ (memory; the original log is on the host) |
| 2,352 of 2,352 requests failed on 20 Oct | `src/fyers/quota.ts` header | ✅ |
| 415 restarts in the holiday crash loop | `src/core/sessionGuard.ts` header | ✅ |
| `exec node --import tsx …` and `stop_grace_period: 20s` | `docker-compose.yml` lines 81 and 90 | ✅ |
| Quota: 4/s and 40/min pacing; allocations 2,200 / 300 / 200 / 1,500; 2 breaches; 65 s cooldown | `config/fyers_quota.json` | ✅ |
| Filter weights 12/20/18/15/25/10, threshold 78, rejects only at REGIME or EV | `src/detectors/janeStreetFilter.ts` | ✅ (corrected in commit `82f3555`) |
| Regime: window 20, minimum 8, 5 buckets, H < 1.6 trending, H > 2.0 ranging | `src/utils/regimeDetector.ts` | ✅ |
| Watchdog 30 s, 6 restarts a day, backoff 30 s to 300 s, stands down at 15:15 | `src/core/sessionGuard.ts` | ✅ |
| 1,584 paper trades in the geometry audit | `select count(*) from paper_trades where entry_time < '2026-10-22'` → 1,584 | ✅ (count matches; the audit itself ran on 21 Oct) |
| t3.small, ap-south-1, 2 vCPU, 1.9 GiB, 16 GB | instance metadata plus `nproc`, `free -h` and `lsblk`, 23 Oct | ✅ |
| Engine about 110 MB and about 4% CPU | monitor log, 22 Oct | ✅ |
| 321 tests on `v2` | `npm test` on the PR #20 merge (= `v2` `2fcbe9e`) | ✅ |
| EMA shadow, 22 Oct: V0 0, V1 2 (−1.36), V2 4 (−4.17) | `/app/data/ema_shadow/2026-10-22.jsonl` summary | ✅ |
| Parity: 177 trades across 15 sessions, and 14,839 of 14,839 | `tests/niftyEmaShadow.test.ts` output; local full-cache check of 21 Oct | ✅ (the test output is reproducible; the full-cache figure came from a session run) |
| Real-Redis check 23/23 | `scripts/ops/realRedisClaims.ts` on a throwaway `redis:7-alpine` (7.4.8) | ✅ |
| EMA study: about 0 net, Trend Pulse +0.078R at 2.3 points, all negative under the futures model | `backtest/studies/nifty-ema-trend/SUMMARY.md` and the correction note | ✅ |

## Unverified or inconsistent items for the owner to decide
1. **Costs:** the EC2 bill, AWS credits, the Vercel plan and the Fyers plan are all unverified (Part 8c).
2. **Backups:** the S3 upload has never worked, and **no restore has been tested** (Part 6.2).
3. **Detector "win rate" comments** (for example "~65%") are unmeasured hypotheses. Consider rewording them in code.
4. **Production dashboard defect:** it calls `http://<host>:8080` from an HTTPS page, so browsers block it as mixed content and it loads no data. This predates the redesign. Fix: remove `VITE_API_URL` from the Vercel environment.
5. **The screener is built but not running:** the scheduler calls `run_screener` at 16:30, but there's no `quant_screener` container on the host.
6. **Live versus backtest VWAP start:** live includes pre-open ticks, while the backtest starts at 09:15.
7. **The worked example** is AEQUS (owner, 23 Oct). Re-check after Friday's saved logs whether a better-documented trade exists.

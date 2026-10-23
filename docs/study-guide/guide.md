# Insider Quant Engine: the study guide

> **Paper trading only.** This engine finds trade setups on NSE stocks and the Nifty index. It scores each setup, sends Telegram alerts, and records *simulated* (paper) trades. **It does not place orders.** There is **no proven trading edge**, and nothing here should be read as a claim of profit.
>
> **Evidence badges** are used throughout:
> - **[Proven]**: observed live on the production host, with logs or database rows.
> - **[Tested on paper]**: covered by unit, parity or real-Redis tests, but not yet seen live.
> - **[Unverified]**: claimed somewhere, but not checked.
>
> **Status labels:**
> - *running*: live every trading day.
> - *built, not running*: code exists, but nothing runs it today.
> - *design only*: written up, not coded.
> - *planned*: an idea on the roadmap.

---

## Part 0: Start here

### 0.1 How to use this guide · Level 1

**Why it matters.** You'll be asked to explain this system by people who have built bigger ones. This guide teaches it in the order you need to understand it:
1. what it is;
2. how data flows;
3. each technology;
4. the trading ideas;
5. how it is run;
6. how we know anything;
7. what went wrong and how it was fixed.

**How each section works.** Each section follows the same shape:
- **why it matters**;
- **the mental model**, with an analogy from React Native first;
- **how it works here**, with real code, config and log lines;
- **what can go wrong**;
- then a **recap**, an **"explain it back"** prompt, a **mini quiz**, and **"interviewer might ask"**.

**Levels.** Level 1 is the basics. Level 2 is working knowledge. Level 3 is a senior deep dive: skip it the first time through.

**One example, followed all the way.** We follow **one real paper trade** from start to finish:
- **AEQUS LONG, 22 Oct 2026, 11:06 IST** (before that day's restart);
- with **JSLL SHORT at 14:13** as the counter-example after the restart.

Both are real rows in the `paper_trades` and `signals` tables (§1.4).

**Recap**
- Read the parts in order. Each one only uses ideas from earlier parts.
- Trust the badges: "Tested on paper" is not "Proven".
- When you're unsure in an interview, say which badge your claim has.

**Explain it back:** What's the difference between "tested on paper" and "proven" in this guide? Why does it matter in an interview?

<details><summary>Mini quiz</summary>

1. Does this engine place orders? **No.** It sends alerts and records paper trades.
2. What does Level 3 mean? **A senior deep dive.** It's optional the first time.
3. What badge does a feature with only unit tests get? **Tested on paper.**
</details>

---

### 0.2 The 60-second and 5-minute pitch · Level 1

**Why it matters.** The first minute sets the interviewer's frame. If you oversell, every follow-up becomes a trap. If you undersell, they don't dig into the good parts.

#### For a non-technical interviewer (60 seconds)

> "It's a personal project that watches the Indian stock market in real time and flags moments when a stock looks like it's breaking out. When it sees one, it scores the setup, and if the score is high enough it sends me a Telegram alert. It also records each alert as a simulated trade, so I can check later whether the ideas actually work. It doesn't trade real money, and it doesn't yet show that it makes money. That's the honest state. What I'm proud of is that it runs every trading day on its own, on a cloud server, and I've made it reliable through some real production incidents."

#### For a senior engineer (5 minutes)

1. **What it is.** A Node.js and TypeScript service on one AWS EC2 host, run with Docker Compose.
   - It subscribes to Fyers' market-data WebSocket for about 25 watchlist stocks plus the Nifty index.
   - It builds candles in memory and runs 2 equity detectors and 5 Nifty detectors.
   - It scores every fire with a multi-gate filter, sends gated alerts to Telegram, and records every fire as a paper trade in Postgres.
   - Redis holds live session state.
   - A Fastify API and SSE stream feed a React dashboard on Vercel.
2. **The interesting engineering.** Constraints and failure modes:
   - Fyers caps the WebSocket at 100 symbols and REST calls at 5/s, 50/min and 5,000/day. More than 3 per-minute breaches block you for the day.
   - I subscribed to more than 2,000 symbols for weeks and got silence. I diagnosed it and fixed it with a capped subscription plan and a boot-time check.
   - The quota ledger is shared across processes.
   - Alerting uses atomic Redis claims (`SET NX` plus Lua compare-and-set), so two detectors firing in the same millisecond can't both alert.
3. **Operations.** Cron-driven daily lifecycle:
   - token refresh at 07:45, boot at 09:00, stop at 15:30;
   - a watchdog with restart backoff, and a day-aware state cleanup;
   - deploys with a backup, a rollback tag, and the engine left stopped until the next scheduled start;
   - never restart during market hours.
4. **Evidence discipline.**
   - The backtest replays 1-minute candles tick by tick through the real detector classes.
   - Parity tests check that live code and backtest give identical results.
   - Studies are pre-registered, with day-block bootstrap confidence intervals.
   - **Result:** the one pre-registered study I ran (an EMA trend study) shows **no edge** after costs. I report that rather than tuning until it looks good.
5. **What I'd do next.** A shadow candle recorder, a managed database, and a mobile backend with authentication.

**Common mistake.** Opening with "I built an algo-trading bot". It invites "How much does it make?" in the first minute. Open with the system and the engineering, and state the paper-only status yourself.

**Recap**
- There are two pitches: plain-language and senior-engineer.
- Say "paper only, no proven edge" before you're asked.
- Lead with constraints and incidents. That's where your real learning is.

**Explain it back:** Give the 60-second version out loud without the word "algorithm".

<details><summary>Mini quiz</summary>

1. Name two Fyers limits that shaped the design. **The 100-symbol WebSocket cap, and REST at 5/s, 50/min, 5,000/day (more than 3 breaches means a blocked day).**
2. Where does live session state live? **In Redis.**
3. What did the pre-registered EMA study find? **No edge after costs.**
</details>

**Interviewer might ask:** *"So does it make money?"* A strong answer: "No evidence that it does. The sample is small, and the one study I ran properly shows no edge after costs. The system is built so I can measure that honestly, which is the point at this stage."

---

## Part 1: The big picture

### 1.1 What the system does, end to end · Level 1

**Mental model.** Think of a React Native app with a background task that keeps a WebSocket open. Each message updates state. Some state changes fire a push notification, and every event is logged to a backend database. Here:
- the "app" is a server process;
- the "messages" are price ticks;
- the "push notification" is a Telegram message;
- the "log" is Postgres.

**What happens on a trading day [Proven]:**
1. **07:45 IST.** An auth service gets a fresh Fyers access token: the market-data login, valid for one day.
2. **09:00.** The engine boots. It reads the watchlist, plans its subscriptions (at most 100 symbols) and connects to the Fyers WebSocket.
3. **09:15–15:30.** For every tick it:
   - updates VWAP and 1-minute candles;
   - runs the detectors on each closed candle;
   - scores any fire with the filter;
   - records it as a paper trade;
   - sends a Telegram alert only if the filter passed and the alert policy allows it.
4. **15:15.** Intraday paper positions are closed by a time exit.
5. **15:30.** The engine is stopped cleanly.
6. **16:00.** The database is backed up.
7. **17:15.** The day's token is deleted.

**Recap**
- Ticks in, candles built, detectors fire, the filter scores, alerts go out, paper trades are recorded.
- A cron-driven lifecycle bounds every day.
- No orders, ever.

<details><summary>Mini quiz</summary>

1. When are intraday paper positions closed? **At 15:15 IST (TIME exit).**
2. What happens at 17:15? **The day's Fyers token is purged.**
3. Is a fire recorded even when it isn't alerted? **Yes. Every fire that reaches the pipeline becomes a paper-trade row; only gated ones alert.**
</details>

---

### 1.2 Real, paper, and not built · Level 1

| Area | Status | Evidence |
|---|---|---|
| Live market data (Fyers WebSocket) | *running* | **[Proven]** heartbeat logs: 25/25 stocks seen, about 1,000 index ticks per 5 minutes on 22 Oct |
| 2 equity and 5 Nifty detectors | *running* | **[Proven]** boot banner `Equity stack: 2 detectors …`, `Nifty stack: 5 detectors …` |
| Telegram alerts (gated only) | *running* | **[Proven]** 3 alerts sent on 22 Oct (`signals.alert_sent`) |
| Paper trades in Postgres | *running* | **[Proven]** `paper_trades` rows with entry, stop, target and exit |
| EMA trend study in shadow (no alerts) | *running* | **[Proven]** `/app/data/ema_shadow/2026-10-22.jsonl` |
| End-of-day screener job | *built, not running* | Scheduled at 16:30 (`lifecycle.sh run_screener`), but the `quant_screener` container doesn't exist on the host, so the engine uses the baked-in `watchlist.json`. The boot log says `screener output not found`. |
| Morning "in-play" re-rank | *design only* | Not coded |
| One-alert-per-symbol duplicate policy | *built, not deployed* | **[Tested on paper]** PR #22, plus a real-Redis check (23 of 23) on a throwaway container |
| Liquid-universe replay fetch (Part D) | *built, not run* | PR #20 is merged. Nothing has been fetched (each fetch evening needs the owner's OK). |
| Mobile backend, dashboard login | *planned* | No code |
| Order execution | *not built, by design* | No broker order API is used anywhere |

**Common mistake.** Saying the screener "picks the stocks every evening". It's built, but it isn't running. Today's watchlist is a static file.

<details><summary>Mini quiz</summary>

1. Is the end-of-day screener running? **No: built, not running.**
2. Which feature has a real-Redis test but no live evidence yet? **The duplicate policy (PR #22).**
3. Does the dashboard have a login? **No. That's planned with the mobile backend.**
</details>

---

### 1.3 The architecture tour · Level 1–2

**Mental model.** Each container is like a separate app on a phone: it has its own process, but they share storage (volumes) and talk over a private network.

```
                        ┌──────────────── EC2 host (one Linux VM, Docker Compose) ─────────────────┐
  Fyers auth ──token──▶ │ quant_auth ──writes──▶ token volume ◀──reads── quant_engine                  │
                        │                                                │  ▲ ticks (WebSocket)        │
  Fyers market data ───────────────────────────────────────────────────▶│  │                          │
                        │ quant_scheduler (cron, IST) ── starts / stops ─▶│                             │
                        │                                                ├──▶ Redis (live state)       │
                        │                                                ├──▶ Postgres (paper_trades,  │
                        │                                                │      signals)               │
                        │                                                └──▶ Telegram (alerts)        │
                        │ quant_api (Fastify, read-only) ◀── Postgres + Redis                         │
                        └──────────────────────────────────────▲───────────────────────────────────────┘
                                                               │ /api/* proxied
                                              Vercel dashboard (React) ── your phone or laptop
```
*What to notice:* only the engine touches market data and Telegram. The API only reads. The dashboard never talks to the host directly; Vercel proxies `/api/*`.

| Service (docker-compose.yml) | Owns | Talks to |
|---|---|---|
| `quant_auth` | the daily Fyers token, written to the `token_store` volume | Fyers login, Telegram (to prompt the owner) |
| `quant_scheduler` | the daily timetable (cron inside a container, timezone IST) | Docker: starts and stops the others |
| `quant_engine` | ticks, candles, detectors, filter, alerts, paper trades | Fyers WebSocket, Redis, Postgres, Telegram |
| `quant_screener` (job) | the evening watchlist (*built, not running*) | Fyers REST, through the quota ledger |
| `quant_api` | read-only REST and SSE for the dashboard | Postgres, Redis |
| `redis_cache` (`quant_redis`) | live session state: VWAP, cooldowns, open positions, alert claims, quota ledger | — |
| `postgres_db` (`quant_postgres`) | the durable record: `paper_trades`, `signals`, `schema_migrations` | — |
| Vercel dashboard (separate repo) | the UI | `/api/*` through a rewrite in `vercel.json` |

**Why one host?** It's simple and cheap, and the load is tiny (the engine uses about 110 MB of memory and 4% CPU on 22 Oct). The trade-off is that there is no redundancy: if the host dies, the day is lost (Part 9).

<details><summary>Mini quiz</summary>

1. Which container is the only one that sends Telegram alerts? **`quant_engine` (`quant_auth` only messages the owner during login).**
2. Where does the dashboard get its data? **From `quant_api`, through Vercel's `/api/*` rewrite.**
3. What holds the token? **The `token_store` volume.**
</details>

---

### 1.4 The life of one tick: AEQUS LONG, 22 Oct 2026 · Level 2

**Mental model.** It's a Redux-style pipeline. Each tick is an action. Reducers update state (VWAP, candles), and selectors (the detectors) fire when a pattern appears. Middleware (the filter and the alert policy) decides whether to dispatch a side effect (Telegram).

**The real trade [Proven]** (rows from `signals` and `paper_trades`):

| Step | What happened (IST) | Where in the code |
|---|---|---|
| 1. Tick | AEQUS ticks arrive on the Fyers WebSocket. Each one updates the symbol's VWAP in Redis (`vwap:NSE:AEQUS-EQ:2026-10-22`). | `src/ingestion/websocket.ts` (`skt.on('message')` → `tickEmitter` → `updateVwap`) |
| 2. Candle and detectors | At **11:06:28** two detectors fire on the same tick. **Stock Momentum Breakout**: "Compression Breakout LONG, box ₹242.00–243.05, 5.3× vol". **Volatility Contraction (VCP)**: "pivot ₹243.05, range −47%, volume dry −48%". | `src/detectors/v2/stockMomentumBreakoutDetector.ts`, `src/detectors/v2/high_alpha/VolatilityContraction.ts` |
| 3. Filter | Both pass. Momentum scores **85**, VCP **88** (threshold 78). Regime: "trending" (entropy H = 1.16). Bayesian P = 0.68 and 0.81. EV ₹2.36 and ₹3.90. Half-Kelly 5%. | `src/detectors/janeStreetFilter.ts` |
| 4. Levels | Entry ₹245.70. The **stop is ₹242.62**, which is **VWAP ₹243.10 × 0.998**, not the detectors' own stops (₹242.14 and ₹241.76). Target ₹250.32 = entry + 1.5 × risk. | `src/workers/alertPipeline.ts` (equity levels come from VWAP) |
| 5. Record | Two paper rows, **#1592 and #1593**, gated, quantity 40. | `src/core/positionTracker.ts` (`registerTrade`) |
| 6. Alert | **Two Telegram alerts went out**, one per detector. That's the duplicate-alert story (Part 8). | `src/workers/alertPolicy.ts` |
| 7. Exit | 12:17:24: price hits the stop (₹242.55). STOP_LOSS, **−1.02R**, −₹126 each. | `positionTracker.processTick` |

*What to notice:*
1. Two independent detectors fired in the **same millisecond**, so both positions got the same id (`trade_<ms>_NSE:AEQUS-EQ`). PR #23 fixes this.
2. The **11:46 watchdog restart** happened while these positions were open.
3. The stop came from VWAP, not from the pattern. That's a known design limit (Part 9).

**Counter-example: JSLL SHORT at 14:13 [Proven].**
- It came after the restart. Momentum scored 85, regime H = 0.29 ("trending" on a flat day; see §4.2).
- Stop ₹356.54 and target ₹340.06 are on the correct sides for a short.
- It was closed by the **15:15 time exit at 0.00R**: the exit price equalled the entry price, ₹349.95.

**What can go wrong here.**
- The detectors run with `Promise.all`, so concurrent fires race (Part 8: duplicates).
- A restart loses in-memory candles (Part 6.3).
- The stop ignores the pattern's own level.

<details><summary>Mini quiz</summary>

1. Why is AEQUS's stop ₹242.62 rather than ₹242.14? **For equities, the pipeline sets the stop at VWAP × 0.998 and ignores the detector's own stop.**
2. How many Telegram alerts did AEQUS produce? **Two, one per detector.**
3. What closed JSLL? **The 15:15 TIME exit.**
</details>

**Interviewer might ask:** *"Why did one setup send two alerts?"* A strong answer: "Two detectors fired concurrently on the same tick. The dedup was per detector, not per symbol. I designed a per-symbol-and-side claim using Redis `SET NX` plus Lua compare-and-set, and tested it against a real Redis with 50-way concurrency. It's on a branch, not deployed yet."

---

### 1.5 One trading day on the clock · Level 1

| IST | What runs | Why then | Source |
|---|---|---|---|
| 07:45 | auth bridge (`lifecycle.sh start_auth`) | a fresh daily token before the market | scheduler crontab |
| 09:00 | engine boot (`start_engine`) | 15 minutes before the open: subscribe and warm up | scheduler crontab |
| 09:03 → 15:40 | read-only monitor checks every 15 minutes | catch silence, restarts, errors and a full disk | host crontab (UTC) |
| 09:07 | "market open" message | owner heads-up | scheduler crontab |
| 09:10 | liveness check | verify the token before trading | scheduler crontab |
| 09:25 | monitor status message to the phone | the boot checklist at a glance | host crontab |
| 15:15 | intraday paper positions time-exit | no overnight intraday risk | `positionTracker.ts` (`isAfter315`) |
| 15:17 | "market close" message | owner heads-up | scheduler crontab |
| 15:30 | engine stop (SIGTERM, exit 0) | at the close | scheduler crontab |
| 15:35 | engine-log export | a recreate deletes Docker's log | host crontab |
| 15:45 | monitor daily summary to the phone | the day's results | host crontab |
| 16:00 | database backup (`db_backup.sh`) | after the close, nothing writing | scheduler crontab |
| 16:30 | screener (*built, not running*) | after the close, end-of-day data | scheduler crontab |
| 17:15 | token purge | the token is only valid for the day | scheduler crontab |

*What to notice:* the scheduler container runs on IST, but the host crontab runs on **UTC** (the host's clock). The same instant has two spellings: 15:35 IST is `5 10 * * 1-5` in UTC.

<details><summary>Mini quiz</summary>

1. Why does the 15:35 job exist? **A container recreate deletes its Docker log, so the log is exported daily.**
2. Which crontab is in UTC? **The host's.**
3. When is the database backed up? **16:00 IST.**
</details>

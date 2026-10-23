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

---

## Part 2: The tech stack, one technology at a time

Each technology gets four answers: **what it is**, **why this project uses it**, **the alternatives and why not**, and **what would break without it**. Versions come from `package.json`, `Dockerfile` and `docker-compose.yml` on `v2`.

### 2.1 TypeScript on Node.js · Level 1
- **What it is:** JavaScript on the server, with types. `Dockerfile` uses `FROM node:22-slim`, and TypeScript runs directly through `tsx`. The container command is `exec node --import tsx src/ingestion/websocket.ts`.
- **Why here:**
  - It's the language you already know.
  - Node's single-threaded event loop suits a stream of small I/O-bound messages (ticks, Redis calls, HTTP).
  - Types catch shape mistakes. `npm run typecheck` must stay at 0 errors.
- **Alternatives:**
  - Python has better quant libraries, but needs a second language and its own async story.
  - Go is faster, but the latency here is network-bound, not CPU-bound.
- **What breaks without it:** nothing magical; you'd rewrite in another language. The real rule that matters is **never block the event loop**. The socket handler only parses and emits. All I/O happens behind `tickEmitter` (`src/ingestion/websocket.ts`).
- **Analogy:** the JS thread in React Native. A long synchronous loop freezes the UI; here it would freeze tick handling.

### 2.2 The Fyers API and WebSocket · Level 2
- **What it is:** an Indian broker's market-data API. There's REST for history and quotes, and a WebSocket that pushes ticks. Client: `fyers-api-v3` (^1.7.0).
- **Why here:** it's the broker account the owner has, and it has free real-time NSE data.
- **Limits that shaped everything** [Proven, Fyers documentation as quoted in `config/fyers_quota.json`]:
  - REST: 5 per second, 50 per minute, 5,000 per day. More than 3 per-minute breaches block the day.
  - WebSocket: 100 symbols (Standard plan).
- **Alternatives:** a paid feed such as Kite Connect, or scraping (unreliable and against the terms).
- **What breaks without it:** no data at all. The token expires daily, so `quant_auth` runs every morning.

### 2.3 Redis · Level 2
- **What it is:** an in-memory key-value store (`redis:7-alpine`, client `redis` ^5.12.1).
- **Why here:** fast shared state the engine reads and writes on every tick:
  - VWAP (`vwap:{symbol}:{date}`);
  - cooldowns;
  - open positions (`trades:open`);
  - alert dedup (`alert:sent:*`);
  - the Fyers quota ledger (`fyers:quota:{day}`).

  It survives an engine restart, because Redis runs in its own container.
- **Key tools:**
  - **TTLs:** keys that expire on their own, like cooldowns.
  - **`SET NX`:** set only if the key doesn't exist. This is an atomic "first one wins".
  - **Lua scripts:** several commands run atomically.
- **Alternatives:** in-process memory (lost on restart), or Postgres for everything (slower per tick, and no TTLs).
- **What breaks without it:** every restart would forget VWAP, cooldowns and open positions. The full key map is in `AGENTS.md` §7.
- **Analogy:** a global state store that lives outside the app, so it survives an app restart.

### 2.4 PostgreSQL · Level 2
- **What it is:** a relational database (`postgres:15-alpine`, client `pg` ^8.23.0).
- **Why here:** the durable record. `paper_trades` holds every position. `signals` holds one row per fire, with the full filter breakdown. Versioned migrations live in `db/migrations/`, and the applied ones are listed in `schema_migrations`.
- **Alternatives:** SQLite (fine for one host, weaker for concurrent writers), or Redis alone (not a durable record).
- **What breaks without it:** no history, no evidence and no dashboard history. The daily `pg_dump` (§6.2) protects it.

### 2.5 Docker and Docker Compose · Level 2
- **What it is:** each service runs in a container built from an image. Compose describes them all in `docker-compose.yml`.
- **Why here:** one command brings the system up the same way every time. Restart policies:
  - `always` for Redis, Postgres, the API and the scheduler;
  - `on-failure` for the engine, so a clean stop stays stopped while a crash restarts.
- **The two things to really understand:**
  - **PID 1 and signals.** The engine's command ends with `exec node ...`, so Node is PID 1 and receives the SIGTERM from `docker stop`. Before that, `sh` was PID 1, ignored SIGTERM, and every stop ended in a SIGKILL with exit code 137 (Part 8).
  - **`stop_grace_period: 20s`.** This gives the shutdown handler time to flush.
- **Analogy:** a release build. The same artifact runs everywhere, and a rollback is "tag the old image, recreate".

### 2.6 AWS EC2 · Level 1
- **What it is:** one rented Linux virtual machine (Ubuntu, a 15 GB disk per `df -h`).
- **Why here:** always on, cheap, simple.
- **Alternatives:** managed containers (ECS or Fargate) or serverless. Those are more moving parts for a single long-lived WebSocket.
- **What breaks without it:** the trading day. There's no second host (Part 9).

### 2.7 Cron, the scheduler container and the host crontab · Level 2
- **What it is:** cron runs commands at fixed times. There are **two** crontabs:
  - one **inside `quant_scheduler`** (timezone IST) for the daily lifecycle;
  - the **host's own crontab** (timezone **UTC**) for the read-only monitor and the log export.
- **Why two:** the monitor must not depend on any container it is watching.
- **Trading days only:** both use the same `trading_day.sh` and holiday file, `scheduler/nse_holidays.txt`.
- **Common mistake:** forgetting the timezone. `5 10 * * 1-5` on the host means 15:35 IST.

### 2.8 Telegram through Telegraf · Level 1
- **What it is:** a bot API. Client `telegraf` ^4.16.3.
- **Why here:** instant, free alerts on your phone.
- **Two destinations:** the **channel**, for trade alerts that passed the filter, and the **admin chat**, for operations notices like watchdog trips and monitor FAILs.
- **What breaks without it:** you'd only see alerts on the dashboard.

### 2.9 Fastify (the API) and Server-Sent Events · Level 2
- **What it is:** a small, fast Node web framework (`fastify` ^5.8.2).
- **Why here:** read-only endpoints for the dashboard: `/api/today`, `/api/trades/history`, `/api/trades/heatmap`, `/api/live-pnl`, and the SSE stream `/api/events`. The engine publishes on Redis pub/sub `sse:events`, and the API relays it.
- **Alternatives:** Express (slower and older), or WebSockets (two-way; this data only flows one way).
- **What breaks without it:** the dashboard. Trading continues.

### 2.10 The dashboard: React, Vite, Tailwind and Recharts on Vercel · Level 1
- **What it is:** a single-page app (React 19, Vite 8, Tailwind 4, Recharts 3) in a separate repo, hosted on Vercel.
- **The trick:** `vercel.json` rewrites `/api/*` to the host's API. The browser only ever talks to Vercel.
- **Honest state:** one `App.tsx` of 1,124 lines, and **no login**. It has known defects, listed in `docs/dashboard-redesign/AUDIT.md`.

### 2.11 Testing: node:test through tsx, the typecheck and ESLint · Level 1-2
- **What it is:** Node's built-in test runner (the `test` script is `tsx --test "tests/**/*.test.ts"`). **Not** Jest or vitest.
- **Scale:** 321 tests pass on `v2` at `2fcbe9e` (`npm test`). There's a strict typecheck (`tsc --noEmit`). ESLint has 20 errors in untouched files that existed before this work.
- **What the tests prove:**
  - parity between the live pipeline and the old worker;
  - parity between the live shadow detector and the backtest;
  - policy rules;
  - the quota rules.
- **What they don't prove:** behaviour against a live market. That's what the badges are for.

<details><summary>Part 2 mini quiz</summary>

1. Why does the engine's command use `exec node`? **So Node is PID 1 and receives SIGTERM, which gives a clean shutdown instead of exit 137.**
2. Why is Redis a separate container? **So live state survives an engine restart.**
3. Which crontab runs on UTC? **The host's.**
4. Which test runner? **`node:test` through `tsx`.**
5. What does the API write? **Nothing. It's read-only.**
</details>

**Interviewer might ask:** *"Why not just use Postgres for state?"* A strong answer: "Per-tick reads and writes, TTL-based cooldowns and atomic first-wins claims are what Redis is built for. Postgres is the durable record. I keep the two jobs separate, and the boot cleanup is day-aware, so a mid-session restart doesn't wipe the Redis state."

---

## Part 3: The trading ideas in plain language

> **Common misconception.** Several detector files open with comments like "~65% win rate in Indian markets" (`niftyOpeningRangeExplosionDetector.ts`) or "highest win-rate intraday Nifty setup" (`niftyVwapReclaimDetector.ts`). **These are hypotheses written while designing, not measurements.** Nothing in this repo has measured them. In an interview, call them "the design thesis" and never "the win rate". Per `CLAUDE.md`: "Never fabricate a performance number."

### 3.1 The vocabulary · Level 1

**Mental model:** before you can follow a game, you learn the words on the scoreboard. These words are on the trading scoreboard.

| Term | Plain meaning | In this repo |
|---|---|---|
| **Tick** | One price update from the exchange | A Fyers WebSocket message with `ltp` (last traded price) and `vol_traded_today` |
| **Candle** (1-, 3- or 5-minute) | The open, high, low and close of all ticks in a time bucket | Built in memory from ticks (`src/utils/candleAggregator.ts`, plus each detector's own buckets) |
| **VWAP** | Volume-weighted average price since the session began: Σ(price × volume) ÷ Σ(volume) | `updateVwap` in `src/utils/vwapUtils.ts`, stored per symbol per day in Redis |
| **Session TWAP** (for Nifty) | An index has no traded volume, so the engine uses the average of minute typical prices, (H+L+C)/3, as its reference | `updateNiftyMinuteState` in `websocket.ts` |
| **EMA** | An exponential moving average, where recent prices weigh more | `src/core/emaTrend.ts` (EMA shadow study) |
| **ADR** | Average daily range: how far a stock usually moves in a day | Used by the screener (*built, not running*) |
| **Stop and target** | The exit price that means "I was wrong" and the one that means "take profit" | For equities the stop is **VWAP × 0.998** (long) or **× 1.002** (short), and the target is entry ± 1.5 × risk (`alertPipeline.ts`) |
| **R-multiple** | Profit or loss measured in units of the initial risk. R = (exit − entry) ÷ (entry − stop) for a long. −1R means "hit the stop exactly". | `paper_trades.r_multiple` |
| **Expectancy** | The average R per trade over many trades. Positive means an edge, but only with a large enough sample. | Bootstrap confidence intervals in `backtest/compare.ts` |
| **Paper trading** | Simulated positions, with no real money | `paper_trades` |
| **Shadow mode** | Running logic for measurement only, so it never alerts | The EMA study; `SHADOW_MODE` for the filter |
| **Gated / ungated** | Passed the filter and was alerted, versus recorded only | `paper_trades.gated` |

**Worked example: R for AEQUS.**
- Entry ₹245.70, stop ₹242.62, so the risk is ₹3.08.
- It exited at ₹242.55: (242.55 − 245.70) ÷ 3.08 = **−1.02R**. That's slightly worse than −1R, because the exit tick was below the stop. That is slippage.
- The rupee loss: −₹3.15 × 40 shares = **−₹126**. That matches `paper_trades.realized_pnl`.

<details><summary>Mini quiz</summary>

1. Why does Nifty use a "session TWAP" instead of VWAP? **An index has no traded volume, so a volume-weighted average isn't defined.**
2. A long trade has entry ₹100 and stop ₹98, and exits at ₹103. What's the R? **+1.5R.**
3. Is +2R on one trade evidence of an edge? **No. Expectancy needs many trades, and a confidence interval.**
</details>

### 3.2 Stock Momentum Breakout · Level 2
**Status:** *running*, part of the equity stack: `buildEquityStack` in `websocket.ts`. **[Proven]** It fires live, for example AEQUS 11:06 and JSLL 14:13 on 22 Oct.

It looks for three setups (from the file header in `src/detectors/v2/stockMomentumBreakoutDetector.ts`):
- **A, Morning Surge** (09:15–09:50): the stock breaks the 09:15 high on 3× the opening candle's volume.
- **B, Intraday Compression Breakout** (09:50–14:30): price stays within 0.5% for 3 consecutive 5-minute candles, then breaks out on 4× average volume. **AEQUS was this**: "box ₹242.00–243.05, 0.43% tight, 5.3× vol".
- **C, VWAP Momentum Continuation:** a pullback to VWAP, then a new 30-minute high or low with volume.

All of them need Nifty bias alignment, a ₹1 crore+ block, and a 30-minute cooldown per stock. Every fire declares `regimeClass: 'MOMENTUM'` and `durationClass: 'INTRADAY'`.

**Picture:**
```
price
 245.7 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ●  breakout candle (5.3× volume)
 243.05 ┌──────────────────────┐
        │  ▪  ▪  ▪   tight box │   3 candles inside 0.5%
 242.00 └──────────────────────┘
 242.62 ············ stop = VWAP × 0.998 (not the box low)
```

**Known weaknesses:**
- The stop comes from VWAP, not from the box, so the risk can be too tight or too loose.
- There's no proof of edge.
- Volume on the first tick after a restart is dropped (§6.3).

### 3.3 Volatility Contraction (VCP) · Level 2
**Status:** *running* (`VolatilityContraction.ts`).

**How it works:**
- It keeps a rolling history of 7 five-minute candles in Redis, `v2:vcp_history:{symbol}`, so it needs 35 minutes of context before it can fire.
- It fires when **the newest candle closes above the pivot**, the high of the contraction box (`history[1..3]`). The range and volume must have shrunk compared with the earlier candles (`history[4..6]`), and the breakout candle needs at least 1.5× the box's average volume.

**Two real bugs are recorded in its own comments:**
- The box used to include the breakout candle itself, so it asked the candle to close above its own high.
- It compared one tick's volume with a 5-minute average, a scale mismatch of about 300×.

Both were fixed in place. That's a good interview story about reading your own code skeptically.

**Known weaknesses:**
- 35 minutes of warm-up.
- The history survives a same-day restart but can join candles across the restart gap. That's a known should-fix from the PR #21 review.

### 3.4 The Nifty detectors · Level 2
**Status:** 5 are wired (`NIFTY_STACK`, `websocket.ts`). Nifty fires become **option** alerts, for example "NIFTY 22650 CE".

| Detector | Idea, from the file header | Backtestable? |
|---|---|---|
| Opening Range Explosion | The first 5-minute range (09:15–09:20) breaks with a 3-minute close outside it, VWAP aligned, before 10:00. On 22 Oct it **skipped**, because the range was 121 points, which is too wide. | yes |
| Trend Pulse | 2 consecutive 3-minute closes in one direction, price more than 0.20% from VWAP, body at least 0.10%, volume at least 1.5× | yes |
| VWAP Reclaim | At least 2 closes on one side of VWAP, then a decisive close back across (body at least 0.12%, not overextended) | yes |
| Institutional OI Liquidity Sweep | Uses option-chain open interest | **no**: option OI isn't cached |
| Delta Hedging Pressure | Uses option-chain OI and delta | **no** |

**Honest limit:** option chains are off (`NIFTY_OPTIONS_ENABLED=false`) until an expiry fix, and option paper positions are never closed in-session (Part 8). So Nifty paper results are not meaningful yet.

### 3.5 The EMA shadow study · Level 2
**Status:** *running in shadow*. It never alerts, never touches the filter, and never writes a paper trade.

- **What:** the pre-registered EMA trend study (`config/nifty_ema_study.json`, three variants, V0/V1/V2) running live on Nifty's own 5-minute candles. It writes JSONL to `/app/data/ema_shadow/<date>.jsonl`.
- **Why "shadow":** to compare live behaviour with the backtest (a parity test) without risking alerts.
- **22 Oct [Proven]:** V0 made 0 trades; V1 made 2 (ΣR −1.36); V2 made 4 (ΣR −4.17). Every row is flagged `warmup_partial` and `bars_incomplete`. **One session means nothing.**
- **Known gaps:**
  - The 15:25 candle is never stored, because the engine stops at 15:30 before that candle can close. That's on the backlog.
  - Warm-up needs 200 stored candles, which is about 3 sessions.

<details><summary>Part 3 mini quiz</summary>

1. Which Momentum setup was AEQUS? **B, Intraday Compression Breakout.**
2. Why can't two Nifty detectors be backtested? **They need option-chain open interest, which isn't cached.**
3. What does "shadow" guarantee for the EMA study? **No alerts, no filter, no paper trades. It only measures.**
4. A file comment says "65% win rate". What do you say? **"That was the design hypothesis. It's unmeasured."**
</details>

**Interviewer might ask:** *"Which of your strategies works best?"* A strong answer: "I don't know yet, and I'd be lying if I picked one. The samples are tiny, and the only study I pre-registered showed no edge after costs. What I can show is that every fire is recorded with its full filter breakdown, so that question can be answered honestly once there's enough data."

---

## Part 4: The filter and the alert policy

### 4.1 The score and its gates · Level 2

**Why it matters.** Detectors are eager: on 22 Oct they fired **21 times**, and only **3** became alerts [Proven, `signals` table]. The filter decides which fires are worth your attention.

**Mental model.** Picture a pull-request review with blocking checks and a quality score:
- **Hard gates** are like failing CI: they block no matter what the score is.
- The **score** (out of 100) is like a reviewer's confidence. Below the bar, the change doesn't ship.

**How it works here** (`src/detectors/janeStreetFilter.ts`):

| Component | Max points | What it asks | Hard gate? |
|---|---|---|---|
| REGIME | 12 | Does the market's current "mode" suit this detector type? | **yes**: an incompatible regime gives score 0 and `rejectedAt: 'REGIME'` |
| STRUCTURE | 20 | Is the breakout clean (a fresh break of structure)? | no |
| LIQUIDITY | 18 | Is there room to the next liquidity pool? | no |
| ORDER_FLOW | 15 | Was it an aggressive candle (body and volume)? | no |
| BAYESIAN | 25 | Posterior P(win) from the evidence (bias, volume, momentum, time window) | listed in `HARD_GATES` (`alertPipeline.ts`), but the filter never rejects at it today: it only contributes points |
| EV_KELLY | 10 | Expected value after slippage, and half-Kelly sizing | **yes**: EV below 0 gives `rejectedAt: 'EV'` (`MIN_EV_PTS = 0`) |

**Pass:** score ≥ **78** (`CONFIRMATION_THRESHOLD`, which can be changed through the environment). The weights add up to 100.

**Worked example [Proven]:**
- **AEQUS VCP scored 88.**

  REGIME 12/12 + STRUCTURE 20/20 + LIQUIDITY 10.8/18 + ORDER_FLOW 15/15 + BAYESIAN 20.2/25 (P = 81%) + EV_KELLY 10/10.
- **JTLIND scored 77** at 10:15, one point under the bar, and was rejected at SCORE.
- **MRPL scored 49** and was rejected at **EV**. It had negative expected value after slippage, so it's blocked even in shadow mode.

**Why the weights are what they are:** the honest answer is **they're assumptions**. `CLAUDE.md` says: "Every `L=` ratio, score weight and win-rate comment is an assumption." Changing the threshold changes how often alerts fire in a non-linear way, so the repo rule is to collect decisions in `SHADOW_MODE` first and reason from the logged distribution (`jsfilter:decisions`).

### 4.2 How the filter misbehaves: the regime-entropy finding · Level 3

**What the regime detector does** (`src/utils/regimeDetector.ts`):
1. It takes the last **20 one-minute Nifty returns**. It needs at least 8.
2. It puts each return into one of **5 buckets** by size: < −0.3%, < −0.05%, ±0.05%, ≤ +0.3%, > +0.3%.
3. It computes the **Shannon entropy** H of that histogram.
4. **H < 1.6 means "trending"**, **H > 2.0 means "ranging"**, and anything in between is "transition".
5. Momentum detectors are allowed in "trending" and blocked in "ranging". Reversion detectors are the opposite.

**Think first:** on a quiet, flat day, almost every 1-minute return is within ±0.05%. What is the entropy?

<details><summary>Answer</summary>

It's very low. Almost everything falls into one bucket, so **H is close to 0**, which the detector labels **"trending"**. JSLL on 22 Oct fired with **H = 0.29, labelled "trending"**, on a quiet afternoon.

Entropy measures **how spread out** the returns are, not **which way** they go. A strong one-way trend with large returns also lands in one bucket. So "low entropy" can mean "flat" or "trending", and the detector can't tell them apart.
</details>

**Why it hasn't been "fixed":** the owner deliberately did **not** change the regime gate. A pre-registered study is on the follow-up list: decide what the test is before running it, then run it. That's the evidence discipline from Part 7, applied to the system's own logic.

**Interviewer might ask:** *"Isn't that a bug?"* A strong answer: "It's a misnamed signal. It measures volatility concentration, not direction. Changing a gate that every alert passes through, without a pre-registered test, would just swap one untested assumption for another. So I documented it and queued the study."

### 4.3 Why alerts are limited · Level 2

**Mental model:** push-notification hygiene in a mobile app. Too many alerts and the user mutes you.

The rules, all in `src/workers/alertPolicy.ts` and `alertPipeline.ts`:
1. **Gated only.** Only fires that pass the filter are sent. Everything else is still recorded, with `alert_suppressed_reason` such as `NOT_GATED` or `FILTER_REJECTED`.
2. **Capital sizing.** A fire that would exceed paper capital is skipped (`CAPITAL_SKIP`) or reduced. The rule is risk at most 1% of capital and at most 10% in one name.
3. **One alert per detector per symbol per day.** This uses `alert:sent:{day}:{detector}:{symbol}`, a `SET NX` with a 36-hour TTL.
4. **A daily cap of 20** (`alert:count:{day}`). The first time it's exceeded, the admin gets one notice.
5. **Fail closed for alerting, fail open for recording.** A filter error records the trade but sends nothing.

**The gap that rule 3 left:** AEQUS at 11:06 fired from **two detectors** at the same moment. Rule 3 is per detector, so both alerts were sent.

**The fix** is *built, not deployed*. It's PR #22, waiting for the owner's review:
- one alert per **symbol and side** while the first position is open, otherwise for 60 minutes;
- options use the 60-minute window only;
- only an **alerted** fire keeps the "paper claim", so duplicate rows are flagged `duplicate_signal` and left out of the stats.

### 4.4 Concurrency done right: atomic claims · Level 3

**Think first:** two detectors run at the same time with `Promise.all`. Each checks "has anyone alerted AEQUS LONG?", sees "no", and both send. How do you stop that?

<details><summary>Answer</summary>

Don't **check, then act**. **Act atomically**: `SET key value NX EX 129600`. Redis guarantees that exactly one caller gets `OK`. The loser gets `null` and treats the fire as a duplicate.
</details>

**The harder parts:**
- **The claim must expire on a business rule** ("position closed and more than 60 minutes old"), not just on a TTL. The winner stores `{ts, positionId}`. A later fire replaces a stale holder with a **Lua compare-and-set**, which does "GET equals what I read, then SET" atomically, so two late fires can't both win.
- **A claim that leads to no alert must be given back.** Causes include a capital skip, a failed send, the cap, or an error. The give-back uses a **Lua compare-and-delete**, so you can only delete your *own* claim.
- **Same-millisecond ids.** Two fires in the same millisecond got the same position id. PR #23 fixes that.

**Evidence:** **[Tested on paper]**, plus a **real-Redis check** (`scripts/ops/realRedisClaims.ts`, on a throwaway Redis 7.4.8 container): **23 of 23 passed**. For example:
- 50 concurrent claims gave exactly 1 winner;
- 20 concurrent takeovers of a stale holder gave exactly 1 winner;
- the TTL was 129,600 s and was reset on takeover.

It is **not yet live**.

<details><summary>Part 4 mini quiz</summary>

1. What's the pass score? **78 out of 100.**
2. Which gates actually block regardless of the score? **REGIME and EV.** These are the only `rejectedAt` values the filter sets. `HARD_GATES` also lists BAYESIAN and KELLY, ready for the day the filter rejects at them.
3. Why is a flat day labelled "trending"? **Low entropy means the returns are concentrated, which a flat day also produces. Entropy doesn't measure direction.**
4. Why `SET NX` rather than GET-then-SET? **Atomicity: two concurrent callers can't both win.**
5. Why give a claim back? **So a fire that sent nothing doesn't block a legitimate alert later.**
</details>

**Interviewer might ask:** *"How would you test this concurrency logic?"* A strong answer: "In layers. First, unit tests with an in-memory store that mirrors the Lua semantics. Then the real pipeline twice under `Promise.all`. Then the same claims against a real Redis in a throwaway container, with 50-way concurrency. Live behaviour is the last layer, and I label it separately."

---

## Part 5: Data and the Fyers limits

### 5.1 The limits · Level 1

**Mental model:** a rate-limited third-party API in a mobile app. Go over the limit and you get 429s. Go over it repeatedly and the vendor blocks your key for the day.

| Limit (Fyers Standard plan) | Value | Source |
|---|---|---|
| Data REST: per second, per minute, per day | 5 / 50 / 5,000 | Fyers documentation, quoted in `config/fyers_quota.json` |
| Penalty | more than 3 per-minute breaches in a day blocks the user for the rest of the day | same |
| WebSocket symbols | **100** per user | `DEFAULT_SUBSCRIPTION_CAP = 100` (`src/core/subscriptionPlan.ts`) |

### 5.2 The quota ledger · Level 2

**Why:** several processes call Fyers REST: the screener, the engine's VWAP seeder, anomaly promotions, and backtest fetches. Each one pacing itself is not enough, because Fyers counts **all** of them together.

**How** (`src/fyers/quota.ts` and `config/fyers_quota.json`):
- **One shared ledger** per IST day in Redis: `fyers:quota:{day}`, holding `used:<job>`, `breaches`, `exhausted` and `cooldownUntil`.
- **Pacing below the limit:** 4/s and **40/min**.
- **Per-job allocations:**

  | Job | Requests per day |
  |---|---|
  | screener | 2,200 |
  | seeder | 300 |
  | anomaly | 200 |
  | backtest | 1,500 |

  They add up to the 5,000 daily limit.
- **Every request is counted *before* the call,** because Fyers counts failed requests too.
- **On a throttle** (Cloudflare 1015, 429 or −360): everyone cools down for at least 65 seconds, and the breach is counted. At **2 breaches** (below Fyers' 3) the job stops for the day.
- **For the replay fetch** (PR #20), stricter rules apply:
  - the **first** throttle stops the run (`maxBreachesPerDay` 1, `maxRetries` 0);
  - at most 1,000 requests per evening;
  - it only starts between 15:45 and 16:15 IST;
  - it needs the owner's OK that evening.

**The incident behind it [Proven, header of `quota.ts`]:** on 20 Oct the first screener run paced at 4 requests per second, which is 240 per minute. Cloudflare throttled it (1015), and it then hit the daily cap: **2,352 of 2,352 requests failed**.

### 5.3 Case study: October's "no alerts" mystery · Level 2

- **Situation.** From 16 Oct, stock alerts stopped completely, while Nifty alerts kept coming.
- **What we found.** The engine subscribed to **2,189 symbols** (log: `All 2189 symbols subscribed across 11 chunks`). The Standard plan streams only **100 per user**. Index ticks kept arriving; stock ticks for almost everything didn't. The engine never complained, because subscribing "succeeded".
- **Proof.** We deployed a **26-symbol** plan: watchlist 25 plus Nifty. The first heartbeat showed `active symbols seen 25/25` and `eq→router 2705`. That was the cap. **[Proven, 21 Oct]**
- **Fix** (`subscriptionPlan.ts`, PR #13):
  - plan the subscription (watchlist + bench + index + options) at boot;
  - **refuse to start** if it exceeds `SUBSCRIPTION_CAP`;
  - log `🧾 Subscription plan: 26/100 symbols …`.
- **Lesson.** "Success" from an API call doesn't mean the data is flowing. Measure the outcome (ticks per symbol), not the request.

<details><summary>Part 5 mini quiz</summary>

1. Why does the ledger count a request before making it? **Fyers counts failed requests too.**
2. Why stop at 2 breaches, not 3? **Stay below Fyers' block threshold, with a margin.**
3. How was the 100-symbol cap proven? **A 26-symbol deploy immediately showed 25 of 25 stocks ticking.**
</details>

---

## Part 6: Operations

### 6.1 Every cron entry and why at that time · Level 1
The full table is in §1.5. The principles behind it:
- the token comes **before** the boot;
- the boot comes **15 minutes before the open**;
- the stop comes **at the close**;
- the backup and the screener come **after the close**;
- the token purge comes **last**.

The monitor runs from the **host** crontab, so it doesn't depend on the containers it watches. Every job checks `trading_day.sh` against `scheduler/nse_holidays.txt`.

### 6.2 Backups · Level 2
- **What:** `pg_dump` writes a full, consistent snapshot of the Postgres database to a file. It's like exporting your app's local database so you can rebuild it on a fresh device.
- **When:**
  - every trading day at **16:00** (`scheduler/db_backup.sh`);
  - and **manually before every deploy**, e.g. `~/backups/pre-guard-20261022T1342Z.dump`. Each manual dump is checked: it must list the 3 data tables (`paper_trades`, `signals`, `schema_migrations`).
- **Honest gaps:**
  - The script's S3 upload **has never worked** (`S3_BACKUP_BUCKET` path issue, recorded in project memory 18 Oct). Backups only live on the same host. **[Unverified off-host copy: none]**
  - A full **restore has not been tested** end to end. **[Unverified]**

  In an interview, say exactly that. "We back up daily, but I haven't proven the restore" is a senior-sounding answer.

### 6.3 Staying up · Level 2
- **Watchdog** (`src/core/sessionGuard.ts`, `websocket.ts`):
  - if no socket message arrives for **30 s** (checked every 10 s), the engine exits 1 and Docker restarts it;
  - the next boot backs off **30 s, 60, 120, 240, up to 300 s**;
  - at most **6 restarts a day**;
  - **from 15:15 IST it stands down instead** (exit 0).
- **Session guard:** the engine won't run on a weekend or an NSE holiday. That's the fix for the 20 Oct holiday crash loop: **415 restarts**.
- **Day-aware boot cleanup** (`src/core/bootCleanup.ts`, deployed 22 Oct):
  - a **new day** clears yesterday's regime, bias, `pnl:daily` and VCP histories;
  - a **same-day restart** keeps them and re-loads the regime returns into memory.

  The bug it fixed: the **11:46 restart on 22 Oct** wiped all of these mid-session.
- **What a restart still loses:** in-memory candles, detector state (for example the opening range), the first tick per symbol, and the EMA shadow's half-built candle.

### 6.4 The deploy procedure · Level 2
```
 copy engine log ─▶ pg_dump (+verify) ─▶ tag current image rollback-<sha> ─▶ git pull
      ─▶ build ONLY quant_engine ─▶ stop ─▶ create --force-recreate (left "Created")
      ─▶ verify the image has the change ─▶ the 09:00 cron starts it
 rollback: docker tag …:rollback-<sha> …:latest && docker compose create --force-recreate quant_engine
```
*What to notice:*
- The engine is **never started** by a deploy. The schedule starts it, so a deploy can't accidentally open a live socket after hours.
- The **log copy comes first**, because a recreate deletes the old container's log. That happened on 22 Oct and the day's log was lost.

**Never restart during market hours (09:00–15:30).** On 21 Oct a manual restart at 11:14 made the VWAP seeder refetch history, used up the day's breach budget, and destroyed the morning's logs. Since then it's a hard rule: during market hours the watchdog handles failures, and people only report.

### 6.5 Monitoring · Level 1
- **Read-only checks:** host cron, every 15 minutes from 09:03 to 15:40 (`~/evidence/monitor/check.sh`). Each one checks:
  - container status and restarts;
  - heartbeat (stocks seen, index ticks per 5 minutes);
  - errors, the quota ledger, disk and memory;
  - fires, alerts and the signals count;
  - EMA shadow output;
  - the 15:15 square-off and the 15:30 stop.
- **Phone messages:** a status line at 09:25, a summary at 15:45, and an immediate message on any FAIL (at most once per issue per hour). They go to the admin chat through the same bot path the engine uses. The token is never printed.
- **Thresholds:**
  - disk above **80%**;
  - index ticks below 300 per 5 minutes for 10 minutes;
  - fewer than 20 of 25 stocks seen;
  - any 429, 1015 or −360 error.

<details><summary>Part 6 mini quiz</summary>

1. Why does a deploy leave the engine in "Created"? **So it starts on schedule, not after hours.**
2. What does the watchdog do at 15:20 if the feed goes silent? **It stands down (exit 0), because there's no time to restart before the close.**
3. What's the honest status of restores? **Never tested end to end.**
4. Why copy the log before a deploy? **A recreate deletes the old container's log.**
</details>

**Interviewer might ask:** *"How do you deploy without downtime?"* A strong answer: "I don't need zero downtime, so I chose zero risk instead. Deploys only happen after the close: back up, tag a rollback image, rebuild only the engine and leave it stopped. The morning cron starts the new build, and a monitor checks the boot at 09:03 and 09:25. Rollback is one command."

---

## Part 7: Testing and evidence

### 7.1 The backtest harness · Level 2
- **What:** it replays historical **1-minute candles** through the **real detector classes** (`backtest/replay/engine.ts`).
  - Each candle becomes 4 synthetic ticks, in the order O→L→H→C or O→H→L→C (`backtest/replay/barToTicks.ts`). Volume is split evenly across the 4.
  - The filter scores each fire at the instant it fired. Exits are simulated with the stop checked first and a 15:15 time exit (`backtest/sim/exit.ts`).
- **Mental model:** an end-to-end test that feeds recorded network responses into your real app code, instead of mocking the screens.
- **Honest limits:**
  - Synthetic ticks are not real ticks: there's no real order of trades inside a minute.
  - Option detectors can't be replayed (no option-chain OI).
  - Live VWAP includes pre-open ticks, but the backtest starts at 09:15 (finding from 22 Oct).

### 7.2 Biases that fool you · Level 2
- **Look-ahead bias:** using information that wasn't available at decision time.
  - **Repo example:** the replay fetch's pre-filter uses **fetch-day quotes** to choose which stocks get history. That's after the ranking date, so the report states it plainly (`backtest/replayReport.ts`).
  - The liquid ranking itself uses only bars dated on or before 14 Oct, and a test proves it (`tests/fetchReplay.test.ts`, "NO LOOK-AHEAD").
- **Survivorship bias:** testing only on stocks that still exist or still look good today.
  - Point-in-time universes are built in `backtest/universes.ts`.
  - A static list such as `watchlist.json` is labelled as look-ahead.

### 7.3 Why small samples mean nothing · Level 2
- **Think first:** you flip a coin 10 times and get 7 heads. Is the coin biased?

  <details><summary>Answer</summary>Probably not. 7 or more heads in 10 fair flips happens about 17% of the time. Ten trades with a 70% win rate is the same story.</details>
- **Day-block bootstrap** (`backtest/compare.ts`):
  - resample **whole days** with replacement, thousands of times;
  - recompute the average R each time;
  - read the 2.5% and 97.5% quantiles as a confidence interval.
- **Why whole days?** Trades on the same day are correlated (same market). Resampling single trades would overstate certainty.
- **House rule:** `n` on every row, and a "small sample, not an edge" note wherever n is small. The redesigned dashboard follows this too.

### 7.4 The EMA study, start to finish · Level 3
1. **Pre-registration** (`backtest/studies/nifty-ema-trend/PREREGISTRATION.md`, committed **before any run**):
   - the variants V0, V1 and V2;
   - the parameters (`config/nifty_ema_study.json`);
   - the costs (2.3 points);
   - the analysis plan.

   No tuning afterwards.
2. **Result** (`SUMMARY.md`): every variant was positive on trend days and negative on choppy days, and **about 0 net**.
3. **Correction:** the comparison baselines had been charged a different cost (5 bps per leg). A labelled correction re-costed everything on one assumption.
   - With 2.3 points, Trend Pulse showed +0.078R.
   - Under a **futures cost model, everything is negative**.
   - Neither cost model is validated.
4. **What it taught:** the honest answer to "does it work?" is "not on this evidence". The value is in the method:
   - pre-register;
   - cost everything the same way;
   - report the null.

### 7.5 Parity tests · Level 3
**Why:** if live code and backtest code drift apart, backtest results say nothing about live behaviour.

| Test | Claim | Evidence |
|---|---|---|
| `tests/niftyEmaShadow.test.ts` | The live EMA shadow, fed tick by tick, produces the **same trades** as the study engine | 177 trades identical across 15 sessions. On the full local cache, 14,839 of 14,839 were identical once both sides had the same cleaned input. |
| `tests/legacyWorkerParity.test.ts` | The current alert worker behaves exactly like the old one for every scenario | It runs both versions' real code side by side and compares every Redis write, send and log line |
| `tests/alertPipeline.test.ts` | The signals hook is purely observational | Behaviour is identical with no hook, a real hook, and a hook that throws |

<details><summary>Part 7 mini quiz</summary>

1. Why resample days, not trades? **Same-day trades are correlated.**
2. What makes pre-registration valuable? **You can't tune to the data after seeing it.**
3. What did the EMA study conclude? **No edge after costs: about 0 net, and negative under the futures model.**
</details>

---

## Part 8: Engineering stories (situation → task → what I found → what I did → what I learned)

Each story is real, with sources in the repo, `CHANGELOG.md` and `AGENTS.md`.

### 8.1 The holiday crash loop
- **Situation.** 20 Oct was an NSE holiday. The engine started anyway and kept dying.
- **Found.** The watchdog exited 1 when the socket stayed silent (there was no market), and Docker restarted it again: **415 restarts** (`src/core/sessionGuard.ts` header).
- **Did.**
  - A trading-day gate at boot, using the holiday file shared with the scheduler.
  - A watchdog policy: at most 6 restarts a day, exponential backoff, and stand down (exit 0) after 15:15.
- **Learned.** A restart policy is code too: "restart on failure" plus "the failure is permanent" makes a loop.

### 8.2 The 100-symbol blindness
See §5.3. **Learned:** measure what arrives, not what you asked for.

### 8.3 The signals-writer stall
- **Situation.** One fire was in the logs but missing from the `signals` table.
- **Found.** Calling `flush()` with an empty queue left a `flushing` promise set forever, so later writes queued behind a promise that never resolved.
- **Did.**
  1. Wrote **failing tests first**: three STALL tests failed with actual 1, expected 3.
  2. Fixed `flush()` to clear its promise when it finishes.
  3. Backfilled the lost rows from the logs, flagged `recovered_from_log`.
- **Learned.** Write the failing test before the fix. And mark recovered data as recovered.

### 8.4 The SIGKILL shutdown (exit 137)
- **Situation.** Every 15:30 stop ended with exit code 137, which means killed.
- **Found.** `sh` was PID 1 and ignored SIGTERM. Docker waited 10 s and sent SIGKILL, so the shutdown handler (flush the signals, close the socket) never ran.
- **Did.** Proved it on a throwaway stub container:
  - with `exec npx`, npm exited in 0.6 s without waiting for its child;
  - with `exec node`, the handler ran and the stub exited 0 in 5.1 s.

  Then shipped `exec node --import tsx …` plus `stop_grace_period: 20s`.
- **Learned.** Containers have an init-process story. Prove the fix on a stub before touching production.

### 8.5 The mid-session restart that wiped state
- **Situation.** 22 Oct, 11:46: the feed went silent for 34 s and the watchdog restarted the engine.
- **Found.** The boot cleanup deleted the regime, the bias, `pnl:daily` and VCP histories on **every** boot. The dashboard's daily P&L dropped to only the closes after 11:46. An independent review then found that **the regime engine never read Redis back**, so just keeping the key wouldn't have been enough.
- **Did.** A day-aware cleanup (a `engine:boot_day` marker), plus re-loading the regime into memory. Reviewed independently and deployed after the close.
- **Learned.** Ask "what survives a restart?" for every piece of state.

### 8.6 The same-millisecond position-id collision
- **Situation.** AEQUS, 11:06:28.169: two detectors fired in the same millisecond.
- **Found.** The id was `trade_<ms>_<symbol>`, so both positions shared it. One overwrote the other in Redis. After the restart only one was counted, and the Postgres close matched **both** rows.
- **Did.**
  - Unique ids (detector slug + random suffix).
  - Closes target the row's primary key.
  - The review found a **blocking ghost race**: a second Redis write could resurrect an already-closed position. Fixed by writing to Postgres first, then making one Redis write.
- **Learned.** Ids built from timestamps aren't unique under concurrency. Independent review catches races that tests miss.

### 8.7 The duplicate alert, and atomic claims
- **Situation.** AEQUS produced two Telegram alerts for one setup.
- **Did.** Per-symbol-and-side atomic claims (§4.4). The reviews found a **blocking** bug: option positions never close in-session, so "while open" would have suppressed option alerts all day. The fix uses the 60-minute window for options.
- **Learned.** Every assumption ("positions close") needs checking against the real data paths.

### 8.8 (Optional) The wrong-side stop
An audit found **0 of 1,584** paper trades with a stop on the wrong side. A guard was still added: such a fire is recorded, flagged `invalid_geometry`, and never alerted.
- **Learned.** Defend the invariants the data says hold today.

---

## Part 8b: Security and secrets · Level 2

**The token flow:**
1. At 07:45 `quant_auth` starts and pings the owner on Telegram.
2. The owner completes the Fyers login.
3. The auth bridge writes the day's access token to the `token_store` volume.
4. The engine reads it at boot.
5. At **17:15** the token is purged.

So a stolen token is only useful until the evening.

**Secrets:**
- They live only in `.env` on the host: Telegram bot token, channel and admin ids, and the Fyers app credentials.
- They're never committed. `.env` was removed from the dashboard repo in commit `5097247`.
- The monitor reads the bot token at send time and passes it to curl on stdin, so it never appears in logs or the process list.

**Honest gaps (say these in an interview before you're asked):**
- **The dashboard has no login.** Anyone with the URL sees the paper P&L. Authentication is *planned* with the mobile backend.
- **The API is read-only but unauthenticated**, and allows any origin (CORS `*`).
- **The production dashboard calls the API over plain HTTP at the host's address.** That puts the address in the JS bundle, and browsers block the calls as mixed content. Found 23 Oct. The fix is the owner's decision: remove `VITE_API_URL` from the Vercel environment, so the app uses the relative `/api` proxy.

**Interviewer might ask:** *"What's your biggest security risk?"* A strong answer: "An unauthenticated read API and a dashboard without login. The data is paper-only and read-only, so the blast radius is information exposure, not money. But it's the first thing I'd fix: put auth in front of the API, serve it only through the HTTPS proxy, and stop baking the backend address into the bundle."

---

## Part 8c: Cost · Level 1

| Item | What it is | Cost |
|---|---|---|
| EC2 | one **t3.small** (2 vCPU, 1.9 GiB of memory, 16 GB disk) in **ap-south-1** (Mumbai), checked from instance metadata on 23 Oct | **Unverified:** check the AWS billing console. On-demand pricing for t3.small is published by AWS. |
| AWS credits | — | **Unverified:** owner to confirm |
| Vercel | dashboard hosting | **Unverified:** plan to be confirmed |
| Fyers API | market data | **Unverified:** depends on the account plan |
| Telegram | bot API | free |

**Why a t3.small is enough:** on 22 Oct the engine used about **110 MB of memory and about 4% CPU** (monitor log). The bottleneck is Fyers' limits, not compute.

**Interviewer might ask:** *"How would costs scale?"* A strong answer: "Compute isn't the constraint. Data rights and API limits are. Scaling to more symbols means a higher Fyers plan or another data vendor before it means a bigger instance."

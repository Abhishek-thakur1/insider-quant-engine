# Study guide: outline for approval

Docs only, branch `docs/study-guide`. Paper trading only, with no proven trading edge.

Every section uses the same shape:
- why it matters;
- the mental model, with an analogy from React Native first;
- how it works here, with real code, config or logs;
- what can go wrong;
- a 3-line recap, an "explain it back" prompt, a mini quiz with collapsed answers, and "interviewer might ask".

Levels: **L1** beginner · **L2** working knowledge · **L3** senior deep dive, collapsed by default.

Two things run through the whole guide:
- **The worked example**, followed from start to finish: the **JSLL SHORT on 22 Oct**. Stock Momentum Breakout fires at 14:13 with a score of 85. The trade has real stop and target levels, a Telegram alert, and a 15:15 time exit at 0.00R. It's chosen because it touches every stage. AEQUS (two detectors in the same millisecond) is the counter-example in Part 8.
- **The evidence badge** on every claim: **Proven** (tested and observed live), **Tested on paper** (unit or parity tests only), or **Unverified**.

## Part 0: Start here
- **0.1 How to use this guide** (L1): the reading order, the badges, the 7-day plan and the cheat sheet, and how to quiz yourself.
- **0.2 The 60-second and 5-minute pitch** (L1): one version for a non-technical interviewer and one for a senior engineer. Includes the honest framing: personal project, paper only, no proven edge.

## Part 1: The big picture
- **1.1 What the system does, end to end** (L1): a signal-and-alert engine for NSE intraday. It watches ticks, finds setups, scores them, sends Telegram alerts and records paper trades. It does not place orders.
- **1.2 Real versus paper versus not built** (L1): what is live, what is simulated, and what was never built (execution, live P&L, multiple hosts).
- **1.3 The architecture tour** (L1–L2), with an SVG diagram:
  - the seven services: auth, scheduler, engine, the end-of-day screener job, API, Postgres, Redis;
  - plus the Vercel dashboard;
  - who owns what, and where each piece of data lives.
- **1.4 The life of one tick** (L2), with an SVG diagram: Fyers WebSocket → candle → detector → filter → alert policy → Telegram, and in parallel the paper tracker → Postgres, told through JSLL.
- **1.5 One trading day on the clock** (L1), with an SVG timeline: from the 07:45 auth through boot, market hours, the 15:15 square-off, the 15:30 stop, the backup, the screener and the token purge.

## Part 2: The tech stack, one technology at a time
Each technology gets the same four parts: what it is, why it's used here, the alternatives and why not, and what breaks without it.
- **2.1 TypeScript on Node.js** (L1): the event loop as "the JS thread you already know". Why one process and why async I/O.
- **2.2 The Fyers API and WebSocket** (L2): REST compared with streaming, the access-token lifecycle, and the official SDK.
- **2.3 Redis** (L2): an in-memory shared store, like a global state store that survives the app. Covers keys, TTLs, `SET NX` and Lua scripts.
- **2.4 PostgreSQL** (L2): the durable record (`paper_trades`, `signals`), versioned migrations, and `pg_dump`.
- **2.5 Docker and Docker Compose** (L2): images compared with containers, volumes, restart policies, PID 1 and signals.
- **2.6 AWS EC2** (L1): one Linux host, and what "single host" means.
- **2.7 Cron, the scheduler container and the host crontab** (L2): why there are two crons, and timezones (the host runs on UTC, the market on IST).
- **2.8 Telegram via Telegraf** (L1): the public channel compared with the admin chat.
- **2.9 Fastify (the API) and Server-Sent Events** (L2): the read-only API, and live updates.
- **2.10 The dashboard: React, Vite, Tailwind and Recharts on Vercel** (L1): the proxy rewrite to the API.
- **2.11 Testing: `node:test` through `tsx`, the typecheck and ESLint** (L1–L2): why there's no Jest or vitest, and what the 300+ tests cover.

## Part 3: The trading ideas in plain language
- **3.1 The vocabulary** (L1): candle, VWAP (and the session average the engine uses instead for the index), ADR, EMA, stop and target, R-multiple, expectancy, paper trading and shadow mode.
- **3.2 Stock Momentum Breakout** (L2): a picture, a worked example (JSLL) and its known weaknesses.
- **3.3 Volatility Contraction (VCP)** (L2): a picture, a worked example and its weaknesses.
- **3.4 The Nifty detectors** (L2): Opening Range Explosion, Trend Pulse and VWAP Reclaim, plus the two option-chain detectors and why those can't be backtested.
- **3.5 The EMA shadow study** (L2): what "shadow" means, the three variants, and why it never sends alerts.

## Part 4: The filter and the alert policy
- **4.1 The score and its gates** (L2): REGIME, BAYESIAN, EV and KELLY, and the 78 threshold.
- **4.2 How the filter misbehaves** (L3): the regime-entropy finding ("trending" on flat days), and why it hasn't been changed (pre-registration).
- **4.3 Why alerts are limited** (L2): only filter-passed alerts are sent, capital sizing, the per-detector daily dedup, the daily cap of 20, and the one-alert-per-symbol-and-side policy (built in PR #22, not deployed yet).
- **4.4 Concurrency done right** (L3): atomic claims with `SET NX`, Lua compare-and-set and give-back, and the test against a real Redis.

## Part 5: Data and the Fyers limits
- **5.1 The limits** (L1): REST at 5/s, 50/min and 5,000/day, with more than 3 per-minute breaches meaning a blocked day; the 100-symbol WebSocket cap.
- **5.2 The quota ledger** (L2): one Redis ledger shared by every caller, with allocations, cooldowns and a hard stop.
- **5.3 Case study: October's "no alerts" mystery** (L2): 2,159 subscribed symbols against a 100-symbol cap. How it was found, the fix (the subscription plan and boot check), and the proof (25 of 25 stocks seen).

## Part 6: Operations
- **6.1 Every cron entry and why it runs at that time** (L1): auth, start, liveness, market messages, stop, backup, screener, token purge, log export and the monitor.
- **6.2 Backups** (L2): what `pg_dump` is, why it runs daily, and how a restore is tested (marked unverified if it never was).
- **6.3 Staying up** (L2): the watchdog, the restart policy and backoff, the session guard, holidays, and why a same-day restart keeps its state (the day-aware cleanup).
- **6.4 The deploy procedure** (L2), with an SVG diagram: copy the log, back up, tag a rollback, rebuild only the engine, leave it Created. Also why we never restart during market hours, and the rollback.
- **6.5 Monitoring** (L1): the read-only checks every 15 minutes, the phone messages, and the 80% disk alert.

## Part 7: Testing and evidence
- **7.1 The backtest harness** (L2): replaying ticks from 1-minute candles through the real detectors.
- **7.2 Biases that fool you** (L2): look-ahead and survivorship bias, with examples from this repo (the fetch-day quote pre-filter).
- **7.3 Why small samples mean nothing** (L2): day-block bootstrap confidence intervals, and "n on every row".
- **7.4 The EMA study, start to finish** (L3): pre-registration, the result (positive on trend days, negative in chop, about zero net), and the cost correction.
- **7.5 Parity tests** (L3): live compared with backtest, legacy worker compared with new worker, and why parity matters.

## Part 8: Engineering stories (situation → task → what I found → what I did → what I learned)
1. **The holiday crash loop:** 415 restarts on 20 Oct.
2. **The 100-symbol cap blindness:** no stock alerts after 16 Oct.
3. **The signals-writer stall:** rows lost after an empty flush.
4. **The SIGKILL shutdown:** exit code 137, because `sh` was PID 1. Fixed with `exec node`, proven on a stub container.
5. **The mid-session restart that wiped state:** the 11:46 watchdog restart, and the day-aware cleanup.
6. **The same-millisecond position-id collision:** AEQUS, with a ghost race found in review.
7. **The duplicate alert:** two detectors on one stock, and atomic claims.
8. **The wrong-side stop:** the geometry guard (optional).

## Part 9: Trade-offs and what I'd do differently
- **9.1 The honest limits** (L2): a single host, Redis as live state, stops derived from VWAP, no per-minute history yet, only 5 live detectors, no proven edge.
- **9.2 The upgrade path** (L3): a managed database, a separate worker, a shadow-candle recorder, a mobile backend with authentication, and notes on scaling.

## Part 10: Interview prep
- **10.1 Question bank** (L1–L3): 40+ questions with honest model answers and likely follow-ups. They cover:
  - architecture, databases, caching, deployment, reliability, testing, concurrency, security;
  - "why not X?" challenges;
  - the hard ones: "Is it profitable?", "How do you know the backtest isn't fooling you?", "How much of this did AI write?"
- **10.2 Weak versus strong answers** (L2): six pairs, with why the weak one fails.
- **10.3 Glossary** (L1): one line per term.
- **10.4 One-page cheat sheet** (L1): for the night before.
- **10.5 The 7-day study plan** (L1): in dependency order, each day ending with its quiz.

## Appendices
- **A. Verification log:** every path, command, number and config value checked, with its source.
- **B. Unverified or inconsistent items** for the owner to decide.

**Deliverables:** `docs/study-guide/index.html` (self-contained: light and dark themes, sticky navigation, search, collapsible deep dives, print CSS, inline SVG), a Markdown copy, the verification log, and a PR for review. After this outline is approved, phase 2 is a shared content file feeding the dashboard's "How it works / Learn" tab. That dashboard work starts with the redesign audit.

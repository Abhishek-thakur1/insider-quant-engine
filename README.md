## ⚠️ Disclaimer

* This engine is built for personal use, not financial advice.<br>
* **Algorithmic trading** carries real risk — markets can humble you fast if you're careless.<br>
* Test thoroughly, trust nothing blindly, and don't deploy real capital without conviction.<br>
* Use it as a tool, not a shortcut — **protect your capital first, profits later**.<br>
* This does not promote intraday/day-trading or high-risk F&O strategies.

# ⚡ Insider Quant Engine

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-232F3E?style=for-the-badge&logo=amazon-aws&logoColor=white)

A signal detection and alerting engine for the Indian equities market (NSE), built on the
**Fyers API V3** and controlled through a **Telegram command bridge**.

**It detects and alerts. It does not place orders.** There is no execution layer, no position
tracking and no P&L anywhere in this repository — the output is a Telegram message. Read that
sentence again before treating any output as a trading system.

---

## 🤖 If you are an AI agent

**Read [`AGENTS.md`](./AGENTS.md) first, completely.** It is the single source of truth: the
architecture, every calculation with its exact formula, the signal-gating mathematics, the Redis
key map, the known defects, and the working conventions. `CLAUDE.md` and `GEMINI.md` point there.

Three things that will otherwise cost you an hour:

1. **17 of the 26 detector classes are not wired into the engine.** 15 are archived under
   `src/detectors/deprecated/`, 3 more are dormant in place. Grep `src/ingestion/websocket.ts`
   for a class name before editing it, or your change does nothing.
2. **Most files carry a large commented-out previous version at the bottom.** Confirm you are
   editing live code, not the archive block.
3. There is a **known live bug** dropping five watchlist equities entirely — `AGENTS.md` §6.11.

---

## 🏗️ Architecture

Four containers, orchestrated by cron inside the scheduler (see `docker-compose.yml`):

```
quant_scheduler   always on. crond + docker-cli, TZ=Asia/Kolkata.
                  Mounts the Docker socket and start/stops its siblings.
       │
       ├── quant_auth     07:45 — sends the Telegram login link, catches the
       │                  Fyers /callback, writes the token, exits.
       ├── quant_engine   09:15 — the live engine. Stopped at 15:30.
       └── redis_cache    always on. AOF, appendfsync everysec.
```

The Fyers access token is single-day: it is written to a shared volume each morning and purged at
15:30 so the next session starts clean.

**Daily lifecycle** (IST, Mon–Fri): `07:45` auth bridge · `09:07` market-open message ·
`09:15` engine boot · `15:17` market-close message · `15:30` engine stop + token purge.

### Signal path

```
Fyers WebSocket
  → synchronous ingestion (cumulative→delta volume diffing, no I/O)
  → EventEmitter
  → routing: Nifty spot | options | equities
  → detectors (8 live)
  → JaneStreetFilter  — Regime → Bayesian → EV → Kelly, one 0-100 score
  → Telegram
```

The filter is the only gate before dispatch, and it **fails open**: if it throws, the alert is
sent unfiltered rather than silently dropped. Two of its checks are hard rejects (regime
mismatch, negative expected value); everything else contributes points to one confidence score.

---

## 🛠️ Tech stack

| | |
|---|---|
| Runtime | Node.js 22, TypeScript, ESM |
| Build | **None.** Run directly with `tsx`. There is no `dist/`. |
| Broker | `fyers-api-v3` — REST for historical candles, WebSocket for ticks |
| State | Redis (`redis` / node-redis v5) |
| Web server | Fastify — only for the auth callback on `0.0.0.0:3000` |
| Alerts | Telegraf (channel broadcast) + `node-telegram-bot-api` (admin DM) |
| Deployment | Docker Compose on AWS |

`ioredis`, `bullmq`, `nodemailer`, `pdfkit` and `node-cron` are in `package.json` but unused in
the live path. There is **no message queue** and no PM2 in the active compose file, despite what
earlier revisions of this README claimed.

---

## 📦 Layout

```
src/
  config/        env, redis client, the Telegram→Fyers auth bridge
  core/          shared types (TickData, IDetector, …)
  ingestion/     websocket.ts ← THE LIVE ENGINE · vwapSeeder · universeBuilder
  utils/         VWAP, options, candle buffer, market structure, liquidity map,
                 order-flow proxy, Bayesian engine, regime detector
  detectors/     janeStreetFilter.ts ← the gating chain
                 v2/ + v2/high_alpha/  ← the 8 live detectors
                 deprecated/           ← 15 archived (importable, not deleted)
  workers/       telegramWorker.ts ← the only alert egress
backtest/        isolated backtest harness — see backtest/README.md
tests/           node:test suites, run with tsx
scheduler/       crontab + lifecycle/message shell scripts
watchlist.json   the 90 symbols the engine subscribes to (5 never reach a
                 detector — see AGENTS.md §6.11)
```

---

## ⚙️ Configuration

Create a `.env` in the repository root:

```env
PORT=3000

# Fyers
FYERS_APP_ID=your_fyers_app_id
FYERS_SECRET_ID=your_fyers_secret          # NOTE: SECRET_ID, not APP_SECRET
FYERS_REDIRECT_URI=http://YOUR_ELASTIC_IP:3000/callback

# Telegram — both are required
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ADMIN_ID=123456789                # your DM chat id, for control
TELEGRAM_CHANNEL_ID=-1001234567890         # broadcast channel, for alerts

# Redis (matches the docker-compose service name)
REDIS_HOST=redis_cache
REDIS_PORT=6379

# Optional
SHADOW_MODE=false                          # log filter decisions without blocking
CONFIRMATION_THRESHOLD=78                  # score needed to fire, 0-100
```

`src/config/env.ts` exits immediately if `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`,
`FYERS_APP_ID`, `FYERS_SECRET_ID` or `FYERS_REDIRECT_URI` is missing. `FYERS_REDIRECT_URI` must
match the Fyers app configuration exactly.

---

## 🚀 Running

```bash
npm install

docker compose up -d                       # full stack
# then send /arm to the Telegram bot to authenticate for the day

npx tsx src/ingestion/websocket.ts         # engine only (needs a token on disk)
npx tsx src/config/auth.ts                 # auth bridge only
```

### Development

```bash
npm run typecheck    # tsc --noEmit --types node  → currently 0 errors
npm test             # node:test via tsx          → currently 53 passing
npm run lint         # eslint
npm run format       # prettier
npm run check        # format + lint + test
```

### Backtesting

```bash
# synthetic — no credentials needed, verifies the harness end to end
BACKTEST_MODE=true npx tsx backtest/demo.ts

# real data — needs a .env with Fyers credentials and a token on disk
npx tsx backtest/run.ts fetch
BACKTEST_MODE=true npx tsx backtest/run.ts run --days 5    # smoke test first
BACKTEST_MODE=true npx tsx backtest/run.ts run
```

`BACKTEST_MODE=true` is mandatory and is asserted on every entry point — without it the
alert-capture seam is inert and detector signals would be **dispatched to Telegram** instead of
collected. See [`backtest/README.md`](./backtest/README.md).

---

## 📊 Honest status

- **No detector has ever been measured.** There is no backtest result, trade journal or outcome
  labelling in this repository. Every likelihood ratio, score weight and win-rate figure in the
  code comments is an assumption. The backtest harness exists to change that; it has not yet been
  run on market data.
- The engine is on branch `v2`; `main` is the deployed state. `AGENTS.md` §11 records exactly
  what changed on `v2` and what remains open.
- Known defects are catalogued in `AGENTS.md` §6, marked resolved / partly resolved / open. Start
  with §6.11 — it is the only one currently losing data.

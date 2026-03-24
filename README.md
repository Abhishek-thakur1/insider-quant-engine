## ⚠️ Disclaimer

* This engine is built for personal use, not financial advice to others.<br>
* **Algorithmic trading** carries real risk — markets can humble you fast if you’re careless.<br>
* Test your strategies thoroughly before putting real capital on the line.<br>
* Test everything, trust nothing blindly, and don’t throw real capital without conviction.<br>
* Use it as a tool, not a shortcut — **protect your capital first, profits later**.


# ⚡ Insider Quant Engine

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![AWS](https://img.shields.io/badge/AWS-232F3E?style=for-the-badge&logo=amazon-aws&logoColor=white)

An institutional-grade algorithmic trading router and signal detection engine built for the Indian Equities Market (NSE). Designed for extreme low-latency execution, zero-friction daily authentication, and robust architectural resilience. 

Powered by the **Fyers API V3** and controlled via a dual-channel **Telegram Command Bridge**.

---

## 🏗️ Core Architecture & Features

* **Biometric Telegram Auth Bridge:** Solves the daily broker login friction. A Fastify-powered webhook intercepts the Fyers cryptographic payload via your phone's FaceID/Fingerprint directly through a secure Telegram Direct Message (`/arm` command). No laptops required to boot the engine.
* **Dual-Layer Signal Routing:** Complete separation of concerns. The engine listens to a secure Admin DM for sensitive commands (ignition, authentication) while broadcasting real-time block trade alerts and mathematical signals (VCP, Volume Spikes) to a public/subscriber broadcast channel.
* **Stateful Historical Seeder:** Pre-computes and syncs intraday VWAP and cumulative volume states using historical 1-minute candle data before the market opens, allowing the engine to fire accurate signals from the very first tick.
* **High-Throughput Firehose:** Seamlessly consumes real-time WebSocket ticks for 100+ equities simultaneously, using Redis for high-speed state management and memory persistence.
* **Resilient Infrastructure:** Engineered for AWS deployment. Utilizes `PM2` daemonization and `Docker` containerization to ensure absolute crash-loop mitigation and 24/7 uptime.

---

## 🛠️ Tech Stack

* **Runtime:** Node.js (v20+)
* **Language:** TypeScript
* **State Management:** Redis
* **Web Server:** Fastify (Exposed on `0.0.0.0:3000` for Auth Bridge payload catching)
* **Broker Integration:** `fyers-api-v3`
* **Process Management:** PM2 / Docker
* **Message Queue:** RabbitMQ

---

## ⚙️ Environment Configuration

Create a `.env` file in the root directory. The engine strictly requires both a private Admin ID (for control) and a Channel ID (for alerts).

```env
# Server Config
PORT=3000

# Fyers API Credentials
FYERS_APP_ID=your_fyers_app_id
FYERS_APP_SECRET=your_fyers_secret
FYERS_REDIRECT_URI=http://YOUR_ELASTIC_AWS_IP:3000/callback

# Telegram Command Bridge
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_ADMIN_ID=123***789          # Your personal DM Chat ID (Secure commands)
TELEGRAM_CHANNEL_ID=-1009*******7    # Your Broadcast Channel ID (Alerts & Signals)

# Redis Config (Matches the docker-compose service name)
REDIS_HOST=redis_cache
REDIS_PORT=6379
PORT=3000
```



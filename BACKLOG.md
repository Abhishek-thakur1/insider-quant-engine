# Backlog: parked items

These are ideas the owner has parked: not scheduled, not started. **Nothing here is approved for building.** Each item needs the owner's go-ahead before work starts. The pointers lead to existing notes; where none exists, that's stated.

Added 2026-10-23, from the owner's list. The order isn't a priority order.

| # | Item | What it is | Existing notes |
|---|---|---|---|
| 1 | In-play re-rank | A pre-open re-rank, at about 09:05-09:08, of the evening screener's top names, using quotes to pick the day's in-play stocks | AGENTS.md: "Not built (planned): pre-open re-rank…" in the screener section |
| 2 | News / LLM | News-driven context or catalysts, possibly LLM-summarised, for alerts or the screener | None in the repo. `docs/qullamaggie-spec-v2.md` "Episodic Pivots (News-Driven Gap Ups)" is related background |
| 3 | Mobile backend | A backend for a mobile client | None in the repo |
| 4 | Part D: index-level Nifty tracking | Tracking Nifty option trades at index level | Migration **0005 is reserved for Part D** (AGENTS.md, CHANGELOG "Migration 0006"). `docs/DATA_PROVENANCE.md` lists `index_option_proxy` rows |
| 5 | Candle recorder | Persist the engine's own live candles, so future studies need no Fyers history calls | None in the repo. Related: `ema_shadow:nifty:bars5` (AGENTS §7) keeps only Nifty 5-minute bars |
| 6 | Duplicate-policy refinements | Refine the one-alert-per-detector-per-symbol-per-day rule | AGENTS.md: the `alert:sent:{IST-date}:{detector}:{symbol}` key and the "Dedup" row in the alert-policy table |
| 7 | Learn animations | Animated explainers for the dashboard's Learn section | The owner calls Learn "stage 3" of the dashboard redesign (see 8) |
| 8 | Dashboard stages 2-3 | Stage 2: Signals and Health views, which need engine PR #24's `/api/signals` and `/api/health`. Stage 3: Learn | Stage 1 shipped 2026-10-23 at `#new`. The dashboard repo's `docs/evidence/stage1/` |
| 9 | Regime-label (entropy) study | Is the Shannon-entropy regime label informative? Live closed trades are 99.7% MOMENTUM by class | AGENTS.md §3.8. `market_regime` is also a factor in the edge-map study (`docs/studies/edge-map/PREREGISTRATION.md`, on branch `study/edge-map`) |
| 10 | Screener first fill | The first full evening fill of the screener v2 cache, about 1,200-1,600 Fyers requests and possibly 2 evenings | `docs/RUNBOOK.md`, screener section (exit 4 = allocation used, continues the next evening). It needs the owner's OK each evening, under the Fyers ledger rules |

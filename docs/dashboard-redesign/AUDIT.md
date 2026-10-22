# Dashboard audit (read-only, for owner approval)

- **Repo:** `N:\trade\insider-quant-dashboard`, the sibling folder `../`.
- **Remote:** `https://github.com/Abhishek-thakur1/insider-quant-dashboard.git`.
- **Branch:** `main` at `0ea81e6`, clean. Nothing was changed.
- **Stack:** React 19, Vite 8, Tailwind 4, Recharts 3, framer-motion, lucide, axios, date-fns.
- **Code:** a single file, `src/App.tsx`, of 1,124 lines.
- **Bundle today (production):** JS 766,549 B and CSS 27,011 B. That is the baseline for the performance budget.

## Current views and features (parity checklist)

**1. Shell**
- Desktop: a sidebar with Dashboard, Trade History and Performance. Settings and Logout are dead links.
- Phone: a bottom navigation bar.
- Header: search (symbol or detector), a detector dropdown, a date picker (no later than today, with a red dot when viewing the past), a bell icon that does nothing, and a "Paper Trading Mode" label.

**2. KPI cards** (shown on every view)
- Realized P&L, with unrealized P&L and the total today, split into intraday and swing with trade count and win %.
- A note before 14 Sep.
- Win rate, from closed trades.
- Active signals: the open-position count plus total R.

**3. Dashboard**
- Active positions grouped by intraday and swing, with entry, target and live P&L.
- A Live / History toggle and CSV export.
- A 28-day "Trading Activity" heatmap. Clicking a day selects that date.

**4. Trade History:** closed trades for the date, intraday and swing sections, CSV export.

**5. Performance**
- A cumulative P&L chart in rupees.
- Total R and average R.
- The intraday/swing split.
- Per-detector total and average R.

**6. Trade modal:** entry, exit, target, stop, regime, status (gated, capital-gated), R and P&L.

**7. Live data**
- Server-Sent Events from `/api/events`: open and close events, plus `pnl_update`.
- `/api/live-pnl` polled every 2.5 s.
- The full fetch is rerun when the SSE connection errors.

## Defects found (to fix in the redesign; not touched now)

1. **The modal invents stop and target levels.** When either is missing it shows a fabricated ±5%. History rows never include them, so every closed trade's modal shows made-up levels. This breaks the "no fake data" rule.
2. **Today's intraday/swing split is rescaled** to the `pnl:daily` total (`scale = total / histTotal`). It mixes two sources, and it was wrong on 22 Oct because of the restart. PR #21 and #23 address the underlying cause.
3. **SSE close events never remove positions that were loaded over REST.** REST rows carry the numeric database id; SSE events carry the string position id.
4. **Live P&L is keyed by symbol,** so two positions on the same symbol overwrite each other.
5. **Ungated trades are never shown:** the UI never passes `includeUngated`. Win rate and R cover only filter-passed trades, without saying so.
6. **The exit-reason type is missing `TIME`.** The heatmap labels closed trades as "signals".
7. **Dead controls:** Settings, Logout, the bell, and the "…" menus. There's also a bogus dependency, `"rechart": "^0.0.1"`.
8. **A hard-coded 14 Sep cutoff note.** It has no theme tokens and no tests.

## Data the new design needs but the API doesn't provide (requests only)

- A signals feed and filter funnel: an endpoint reading the `signals` table.
- System health: the engine heartbeat (ticks per 5 minutes, stocks seen), the last restart, quota state, and the monitor's last PASS or FAIL.
- Market status and the Nifty level and day change.
- Watchlist heat: day change for each tracked stock.
- `data_quality` flags, plus target and stop on history rows.
- `gated` and `regimeClass` in `/api/today`.

## Still to do (next session)

- HTML wireframes: shell, Today, Positions, Signals, Health and Learn, at phone and desktop widths.
- Design tokens.
- Proposed defaults:
  - a dark base with one calm accent;
  - `/classic` kept for 2 weeks;
  - Learn behind an unlinked route;
  - phone priority: Today, Positions, Signals, Health.

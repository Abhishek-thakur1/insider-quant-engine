# Daily watchlist: ranking rules dw-2 (pre-registration)

**Committed before the scan that uses it** (owner, 2 Nov 2026, evening). Version **`dw-2`** replaces dw-1 (`PREREGISTRATION.md`, kept unchanged as the record of the 2 Nov scan). Nothing here claims an edge; whether the list helps is **untracked**.

## What changes from dw-1

1. **As-of rule.** A quote counts for the as-of day if:
   - the IST calendar date of its `tt` equals the as-of day, **and**
   - its `volume` is above 0.

   Fyers documents `tt` as "Today's time", a date stamp, so there is no time-of-day check. dw-1's 09:15–15:30 check on `tt` admitted nothing.
2. **Request cap: 48 in total** (owner OK for one scan, 3 Nov). That is 1 symbol-master download + at most **47** quote requests, retries included. If the universe needs more than 47 quote batches of 50, the scan fails right after the master download, before any quote call. If the cap is reached mid-scan, the scan fails.
3. **Raw quote sample.** Every raw quote response is saved, one JSON line per batch, to `raw_quotes/<forSession>.jsonl` in the output directory, written as each batch returns (failed scans keep it too). The run also reports how many quotes passed each step: quoted, as-of day, price, turnover, range.

## Unchanged from dw-1

- Universe, core 25 (`config/daily_watchlist_core.json`), floors (₹50, ₹50 crore turnover, prev close > 0, high > low).
- Measures, score (0.4 move + 0.3 range + 0.3 turnover percentiles), order and ties, 69 rotating slots.
- Validation (60–94 unique well-formed stocks, rotating names in the master, at most 10% of quote batches failed, within the cap).
- Output format (`rulesVersion: "dw-2"`). No scan between 09:00 and 15:30 IST on a trading day.

## The 3 Nov scan (operational, owner's terms)

- **One scan**, at about 16:10 IST on Tue 3 Nov, while the day's token exists (it's deleted at 17:15). No other Fyers call.
- **Read-only for the live system:** the output goes to an evidence directory on the host (`SCREENER_DATA_DIR`), not the `screener_data` volume. The running engine doesn't read the daily list in any case.
- The owner reviews the list before anything uses it.

## The 3 Nov scan: result

Exit 2, nothing written. The universe needed 48 quote batches, more than the 47 allowed, so the scan stopped after the master download, before any quote call (1/48 requests used, 0 quote requests). The ranking rules were not exercised.

## Amendment for the 4 Nov scan: request cap 55 (owner, 3 Nov evening; committed before the code change and the scan)

The ranking rules above are unchanged, so the version stays **`dw-2`**. Only the request budget changes:

- **55 Fyers requests in total:** 1 symbol-master download + at most **48** quote batches of 50 + at most **6** retries.
- **The batch count is computed first,** from the master. If it is above 48, the scan fails before any quote call.
- **Retries:** quote attempts are capped at the batch count + 6, and never above 54. Every attempt counts, retries included. If the cap is reached, the scan fails.
- **One scan,** Wed 4 Nov, 16:05–17:00 IST only, started by checking the clock directly. The output goes to the evidence folder only. #65 and #66 stay unmerged until the owner has seen the list.

# Proposal: remove the old `vwap:*` keys (not run)

**Status:** proposal only. Nothing has been deleted. It needs the owner's OK, outside market hours.

## Facts (read-only, 26 Oct 2026, about 22:00 IST)

- Redis holds **4,485** `vwap:{symbol}:{date}` keys, from 2026-09-08 to 2026-10-26. The day with the most is 13 Oct, with 267.
- Before `fix/vwap-ttl`, none of them had a TTL. After that PR is deployed, new keys expire 36 h after their last write. The **existing keys keep no TTL** until they are rewritten, and a past day's key is never rewritten.
- Only today's keys are read: `getVwap`, the seeder's `isSeeded`, and the API's `stocksSeenToday`. Each key is a small JSON string of about 100 bytes, so the whole set is roughly 1 MB with Redis overhead. This is housekeeping, not a memory emergency.
- **The old keys hold data with study value.** They are the engine's own record of each symbol's daily traded value (Σ price × volume) and volume, used by edge-map tables §J. The 51 study names plus Nifty are already exported and committed (`docs/studies/edge-map/liquidity_vwap_export_2026-10-26.tsv`). The other ~3,650 keys are not.

## Proposed steps (after `fix/vwap-ttl` is deployed)

1. **Export everything first**, read-only. Copy the archive off the host and record its sha256.
   ```
   docker exec quant_redis redis-cli --scan --pattern 'vwap:*' | sort > /tmp/vk.txt
   sed 's/^/GET /' /tmp/vk.txt | docker exec -i quant_redis redis-cli > /tmp/vv.txt
   paste -d'\t' /tmp/vk.txt /tmp/vv.txt | gzip > ~/evidence/vwap-keys-<date>.tsv.gz
   ```
2. **Dry run:** count the keys whose date is before yesterday (IST). Show the count and the first and last date. Nothing is deleted yet.
3. **On the owner's OK, put a TTL on those keys** rather than deleting them, for example `EXPIRE <key> 86400`. They then disappear within a day, and an export in step 1 that turned out to be wrong can still be redone before then. `UNLINK` is the immediate alternative.
4. **Verify:** the next day, `--scan --pattern 'vwap:*'` shows only the last ~2 days' keys.

**Never touch today's keys** (`vwap:*:<today>`): the live engine reads them. The steps above run only outside 09:00–15:30.

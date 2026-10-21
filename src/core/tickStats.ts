// ============================================================
// core/tickStats.ts — per-heartbeat tick accounting (pure, diagnostics only)
//
// Oct 21: the socket delivered ~1,000 messages / 5 min with 2,158 equities
// subscribed, yet not one watchlist equity reached updateVwap (no
// vwap:*-EQ:2026-10-21 key). The heartbeat counted raw messages only, so it
// could not say whether equity ticks were absent or dropped by the zero-volume
// filter. These counters split every message and tick by its fate.
//
// Never affects routing: websocket.ts increments counters after deciding,
// and the watchdog interval prints and resets them. No I/O here.
// ============================================================

export interface TickStats {
	unparsed: number // message neither JSON tick(s) nor { data: [] } — control/ack frames
	ticks: number // tick objects pulled out of parsed messages
	noLtp: number // tick without symbol or ltp → skipped
	index: number
	option: number
	eqActive: number // active-universe equity emitted to the router
	eqInactive: number // non-active equity emitted (→ anomaly scanner)
	eqZeroVol: number // equity dropped: vol_traded_today did not rise
	eqNoVolField: number // equity tick whose vol_traded_today is missing/0 (subset of eqZeroVol, mostly)
	activeSymbols: Set<string> // distinct active-universe symbols seen (emitted or dropped)
	sampleEquity: string | null // first equity tick of the beat, raw, truncated
	sampleUnparsed: string | null
}

export const newTickStats = (): TickStats => ({
	unparsed: 0,
	ticks: 0,
	noLtp: 0,
	index: 0,
	option: 0,
	eqActive: 0,
	eqInactive: 0,
	eqZeroVol: 0,
	eqNoVolField: 0,
	activeSymbols: new Set(),
	sampleEquity: null,
	sampleUnparsed: null,
})

const SAMPLE_CHARS = 300

export const sampleOf = (value: unknown): string => {
	try {
		const s = typeof value === 'string' ? value : JSON.stringify(value)
		return (s ?? String(value)).slice(0, SAMPLE_CHARS)
	} catch {
		return '[unserialisable]'
	}
}

export const formatTickStats = (s: TickStats, activeUniverseSize: number): string[] => {
	const lines = [
		`[Firehose] ♥ ticks ${s.ticks} | index ${s.index} | option ${s.option} | eq→router ${s.eqActive} | eq→scanner ${s.eqInactive} | eq dropped zero-vol ${s.eqZeroVol} (no vol field ${s.eqNoVolField}) | no ltp ${s.noLtp} | non-tick msgs ${s.unparsed} | active symbols seen ${s.activeSymbols.size}/${activeUniverseSize}`,
	]
	if (s.sampleEquity) lines.push(`[Firehose] ♥ sample equity tick: ${s.sampleEquity}`)
	else lines.push('[Firehose] ♥ sample equity tick: none this beat')
	if (s.sampleUnparsed) lines.push(`[Firehose] ♥ sample non-tick msg: ${s.sampleUnparsed}`)
	return lines
}

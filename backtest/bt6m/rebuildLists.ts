// ============================================================
// backtest/bt6m/rebuildLists.ts — point-in-time dw-3 lists for the 6-month backtest (offline, no network)
//
// docs/studies/backtest-6m/PREREGISTRATION.md §4. For each session in <BT6M_DIR>/asof_days.txt
// ("<session> <asOf>"), runs the live dw-3 ranking (src/screener/bhavcopy.ts runBhavScan, unchanged) on the
// locally saved NSE bhavcopy <BT6M_DIR>/bhav/<asOf>.csv.zip, with the live core 52 and the 28 Apr
// fyersUniverse.json (ac7e962; asserted, so a refreshed file can't leak in). Writes <BT6M_DIR>/lists/<session>.json
// and a summary. No Fyers call, no download, no Telegram (runBhavScan never alerts; notifyAdmin isn't imported).
// Usage: BT6M_DIR=C:/trade-data/backtest-6m npx tsx backtest/bt6m/rebuildLists.ts
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { runBhavScan } from '../../src/screener/bhavcopy.js'

/** git blob SHA-1 of fyersUniverse.json at ac7e962 (28 Apr 2026): the file the live Fyers check used. */
export const FYERS_UNIVERSE_BLOB_AC7E962 = process.env.BT6M_FYERS_BLOB ?? ''
export const FYERS_UNIVERSE_AS_OF = '2026-04-28'

export const gitBlobSha1 = (buf: Buffer): string =>
	crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex')

export const readAsofDays = (file: string): { session: string; asOf: string }[] =>
	fs
		.readFileSync(file, 'utf8')
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const [session = '', asOf = ''] = l.split(/\s+/)
			if (!/^\d{4}-\d{2}-\d{2}$/.test(session) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf >= session)
				throw new Error(`bad asof_days line: ${l}`)
			return { session, asOf }
		})

const main = async (): Promise<number> => {
	const dir = process.env.BT6M_DIR
	if (!dir) throw new Error('set BT6M_DIR')
	const uniBuf = fs.readFileSync(path.resolve(process.cwd(), 'fyersUniverse.json'))
	const blob = gitBlobSha1(uniBuf)
	if (!FYERS_UNIVERSE_BLOB_AC7E962 || blob !== FYERS_UNIVERSE_BLOB_AC7E962)
		throw new Error(`fyersUniverse.json blob ${blob} is not the ac7e962 file (set BT6M_FYERS_BLOB from \`git rev-parse ac7e962:fyersUniverse.json\`)`)
	const fyers = { file: 'fyersUniverse.json', asOf: FYERS_UNIVERSE_AS_OF, symbols: new Set(JSON.parse(uniBuf.toString('utf8')) as string[]) }
	const core = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'config', 'daily_watchlist_core.json'), 'utf8')) as string[]
	const outDir = path.join(dir, 'lists')
	fs.mkdirSync(outDir, { recursive: true })

	const summary: { session: string; asOf: string; kind: string; stocks?: number; dropped?: number; reason?: string }[] = []
	const rotatingUnion = new Map<string, number>()
	for (const { session, asOf } of readAsofDays(path.join(dir, 'asof_days.txt'))) {
		const zipPath = path.join(dir, 'bhav', `${asOf}.csv.zip`)
		const r = await runBhavScan({
			asOf,
			forSession: session,
			nowMs: Date.parse(`${asOf}T13:30:00Z`), // 19:00 IST on the as-of day, as the live job
			core,
			fyers,
			fetchZip: async () => (fs.existsSync(zipPath) ? fs.readFileSync(zipPath) : null),
			writeFile: () => {}, // nothing written by the scan; the driver writes the list below
			log: { log: () => {}, warn: () => {} },
		})
		if (r.kind === 'written') {
			fs.writeFileSync(path.join(outDir, `${session}.json`), r.text)
			for (const e of r.file.entries) if (e.group === 'rotating') rotatingUnion.set(e.symbol, (rotatingUnion.get(e.symbol) ?? 0) + 1)
			summary.push({ session, asOf, kind: r.kind, stocks: r.file.symbols.length, dropped: r.file.fyersCheck?.dropped.length ?? 0 })
		} else summary.push({ session, asOf, kind: r.kind, reason: r.reason })
	}
	const ok = summary.filter((s) => s.kind === 'written').length
	const coreSet = new Set(core)
	const out = {
		sessions: summary.length,
		written: ok,
		failed: summary.filter((s) => s.kind !== 'written'),
		core: core.length,
		rotatingUnique: rotatingUnion.size,
		rotatingAlsoCore: [...rotatingUnion.keys()].filter((s) => coreSet.has(s)).length,
		symbolsNeeded: new Set([...core, ...rotatingUnion.keys()]).size + 1, // + Nifty
		rotatingDaysListed: [...rotatingUnion.entries()].sort((a, b) => b[1] - a[1]),
		perSession: summary,
	}
	fs.writeFileSync(path.join(dir, 'lists_summary.json'), JSON.stringify(out, null, 1))
	console.log(JSON.stringify({ sessions: out.sessions, written: out.written, failed: out.failed.length, rotatingUnique: out.rotatingUnique, symbolsNeeded: out.symbolsNeeded }))
	return out.failed.length ? 2 : 0
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('backtest/bt6m/rebuildLists.ts'))
	main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1) })

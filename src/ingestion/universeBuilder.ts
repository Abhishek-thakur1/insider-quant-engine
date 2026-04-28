import axios from 'axios'
import csv from 'csv-parser'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const FYERS_NSE_CM_URL = 'https://public.fyers.in/sym_details/NSE_CM.csv'
const OUTPUT_PATH = path.resolve(process.cwd(), 'fyersUniverse.json')

export const buildUniverse = async (): Promise<void> => {
	console.log(`[Universe Builder] 📥 Downloading latest symbols from Fyers...`)

	const universe: string[] = []

	try {
		const response = await axios({
			method: 'get',
			url: FYERS_NSE_CM_URL,
			responseType: 'stream',
		})

		response.data
			.pipe(
				csv([
					'fytoken',
					'name',
					'instrument_type',
					'lot',
					'tick',
					'isin',
					'trad_ses',
					'last_upd',
					'expiry_dt',
					'symbol',
					'exchange',
					'segment',
					'script_code',
					'short_sym',
					'strike',
					'opt',
					'fytoken2',
				]),
			)
			.on('data', (row: any) => {
				// 1. Must end with -EQ (Cash Market)
				// 2. ISIN MUST start with "INE" (Excludes INF = ETFs/Mutual Funds)
				if (row.symbol && row.symbol.endsWith('-EQ') && row.isin && row.isin.startsWith('INE')) {
					universe.push(row.symbol)
				}
			})
			.on('end', () => {
				fs.writeFileSync(OUTPUT_PATH, JSON.stringify(universe, null, 2))
				console.log(
					`[Universe Builder] ✅ Successfully built universe with ${universe.length} EQ stocks.`,
				)
				console.log(`[Universe Builder] 💾 Saved to ${OUTPUT_PATH}`)
			})
			.on('error', (err: any) => {
				console.error(`[Universe Builder] ❌ Error parsing CSV:`, err)
			})
	} catch (error) {
		console.error(`[Universe Builder] ❌ Failed to download master file:`, error)
	}
}

const currentFilePath = fileURLToPath(import.meta.url)
if (process.argv[1] === currentFilePath) {
	buildUniverse()
}

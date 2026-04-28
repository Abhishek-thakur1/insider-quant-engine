import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const WATCHLIST_PATH = path.resolve(process.cwd(), 'watchlist.json')
const UNIVERSE_PATH = path.resolve(process.cwd(), 'fyersUniverse.json')

const validateWatchlist = () => {
	if (!fs.existsSync(WATCHLIST_PATH)) {
		console.error('❌ Error: watchlist.json not found in root directory.')
		return
	}

	if (!fs.existsSync(UNIVERSE_PATH)) {
		console.error('❌ Error: fyersUniverse.json not found. Run universeBuilder.ts first.')
		return
	}

	console.log('🔍 Validating watchlist against active Fyers Universe...\n')

	const watchlist: string[] = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf-8'))
	const universe: string[] = JSON.parse(fs.readFileSync(UNIVERSE_PATH, 'utf-8'))

	const universeSet = new Set(universe)
	const mismatches: string[] = []

	for (const symbol of watchlist) {
		if (!universeSet.has(symbol)) {
			mismatches.push(symbol)
		}
	}

	if (mismatches.length > 0) {
		console.log(`⚠️  Found ${mismatches.length} invalid or delisted symbols in your watchlist:`)
		mismatches.forEach((sym) => console.log(`   ❌ ${sym}`))
		console.log(
			'\nPlease remove or correct these in watchlist.json to prevent WebSocket subscription failures.',
		)
	} else {
		console.log(
			`✅ Validation Passed! All ${watchlist.length} symbols are actively trading on Fyers.`,
		)
	}
}

// ESM Execution Guard
const currentFilePath = fileURLToPath(import.meta.url)
if (process.argv[1] === currentFilePath) {
	validateWatchlist()
}

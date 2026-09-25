import test from 'node:test'
import assert from 'node:assert'
import { AnomalyScanner } from '../src/ingestion/anomalyScanner.js'

test('AnomalyScanner - promotes symbol on >5% ADV and >1.5% price spike', (t) => {
	const scanner = new AnomalyScanner()
	
	// Mock stats map directly for testing
	;(scanner as any).stats = {
		'NSE:TEST-EQ': {
			advShares: 100_000,
			adr: 5.0,
			turnover: 15_000_000,
			close: 150
		}
	}

	let promotedSymbol: string | null = null
	let promoteReason: string | null = null
	scanner.onPromote = (sym, reason) => {
		promotedSymbol = sym
		promoteReason = reason
	}

	const activeSet = new Set<string>()

	// Feed 5 minutes of ticks
	// T0
	scanner.updateTick('NSE:TEST-EQ', 100.0, 1000)
	;(scanner as any).processMinuteBoundary(activeSet)
	// T1
	scanner.updateTick('NSE:TEST-EQ', 100.5, 2000)
	;(scanner as any).processMinuteBoundary(activeSet)
	// T2
	scanner.updateTick('NSE:TEST-EQ', 101.0, 3000)
	;(scanner as any).processMinuteBoundary(activeSet)
	// T3
	scanner.updateTick('NSE:TEST-EQ', 101.5, 4000)
	;(scanner as any).processMinuteBoundary(activeSet)
	
	// T4 - Big spike!
	// Price goes from 100.0 to 102.0 (2% move, threshold is 1.5%)
	// Volume goes from 1000 to 15000 (diff 14000, threshold is 10000)
	scanner.updateTick('NSE:TEST-EQ', 102.0, 15000)
	;(scanner as any).processMinuteBoundary(activeSet)

	assert.strictEqual(promotedSymbol, 'NSE:TEST-EQ')
	assert.ok(promoteReason?.includes('2.0%'))
})

test('AnomalyScanner - ignores already active symbols', (t) => {
	const scanner = new AnomalyScanner()
	;(scanner as any).stats = {
		'NSE:ACTIVE-EQ': {
			advShares: 100_000,
			adr: 5.0,
			turnover: 15_000_000,
			close: 150
		}
	}

	let promoted = false
	scanner.onPromote = () => { promoted = true }
	
	const activeSet = new Set(['NSE:ACTIVE-EQ'])
	
	for (let i = 0; i < 5; i++) {
		scanner.updateTick('NSE:ACTIVE-EQ', 100 + i, 1000 * i)
		;(scanner as any).processMinuteBoundary(activeSet)
	}

	assert.strictEqual(promoted, false)
})

test('AnomalyScanner - ignores illiquid symbols', (t) => {
	const scanner = new AnomalyScanner()
	;(scanner as any).stats = {
		'NSE:PENNY-EQ': {
			advShares: 10_000,
			adr: 5.0,
			turnover: 1_000_000, // < 10M threshold
			close: 10
		}
	}

	let promoted = false
	scanner.onPromote = () => { promoted = true }
	const activeSet = new Set<string>()
	
	for (let i = 0; i < 5; i++) {
		// Massive 10% move and 5000 volume spike
		scanner.updateTick('NSE:PENNY-EQ', 10 + i, 1000 * i) 
		;(scanner as any).processMinuteBoundary(activeSet)
	}

	assert.strictEqual(promoted, false)
})

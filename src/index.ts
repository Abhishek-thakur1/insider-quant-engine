import { sendTelegramAlert } from './workers/telegramWorker.js'

console.log('Quant Engine Initialized')

console.log('🚀 Quant Engine Booting Up...')

// Mock data to simulate an insider volume spike
const mockAnomaly = {
	symbol: 'NSE:NETWEB-EQ',
	price: 2450.55,
	percentageChange: 4.2,
	volumeSpikeRatio: 6.5,
	trigger: 'Order Book Squeeze & Volume Surge',
}

// Fire the test alert instantly on boot
// sendTelegramAlert(mockAnomaly);

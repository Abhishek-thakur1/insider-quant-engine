import fs from 'fs'
import path from 'path'

const resultsPath = path.resolve('backtest/output/results.json')
const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))

const targets = ['Candle Accumulation Breakout', 'Nifty Options Scalper', 'Gap_And_Go_V2', 'ORB Breakout']

const summarize = (detector: string) => {
    let evRejects = 0
    let evRejectsPrices = []
    let evRejectsReturnInR = 0
    let passed = 0
    let passedPrices = []
    
    for (const session of data.run.sessions) {
        for (const sig of session.signals) {
            if (sig.detectorDisplayName !== detector) continue;
            
            const rReturn = sig.result?.r ?? 0;
            
            if (sig.gate && !sig.gate.passed && sig.gate.rejectedAt === 'EV') {
                evRejects++
                evRejectsPrices.push(sig.payload.price)
                evRejectsReturnInR += rReturn
            } else if (sig.gate && sig.gate.passed) {
                passed++
                passedPrices.push(sig.payload.price)
            }
        }
    }
    
    const avgPriceRej = evRejectsPrices.length > 0 ? evRejectsPrices.reduce((a,b)=>a+b,0)/evRejectsPrices.length : 0
    const avgPricePass = passedPrices.length > 0 ? passedPrices.reduce((a,b)=>a+b,0)/passedPrices.length : 0
    const avgREv = evRejects > 0 ? evRejectsReturnInR / evRejects : 0
    
    console.log(`Detector: ${detector}`)
    console.log(`  EV Rejects: ${evRejects} (Avg Price: ₹${avgPriceRej.toFixed(2)}, Avg simulated R: ${avgREv.toFixed(3)})`)
    console.log(`  Passed Gate: ${passed} (Avg Price: ₹${avgPricePass.toFixed(2)})`)
}

for (const d of targets) summarize(d)

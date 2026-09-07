const fs = require('fs');
const tradesJson = JSON.parse(fs.readFileSync('backtest/output/trades.json', 'utf8'));

['stock_momentum_breakout', 'gap_and_go'].forEach(name => {
    const trades = tradesJson[name];
    if (!trades) return;
    
    // Sort by entryTs
    trades.sort((a,b) => a.entryTs - b.entryTs);
    
    let overlapping = 0;
    let independent = 0;
    
    // Map to track open positions per underlying
    const openPositions = new Map(); // underlying -> exitTs
    
    for (const t of trades) {
        const openExitTs = openPositions.get(t.underlying);
        if (openExitTs && openExitTs > t.entryTs) {
            overlapping++;
        } else {
            independent++;
            openPositions.set(t.underlying, t.exitTs);
        }
    }
    
    // Compute Profit Factor
    let grossProfit = 0;
    let grossLoss = 0;
    
    // Compute Top 1% and 5% share
    const rs = trades.map(t => t.r).sort((a,b) => a - b);
    const totalR = rs.reduce((a,b) => a+b, 0);
    const count = rs.length;
    const top1Share = rs.slice(Math.floor(count * 0.99)).reduce((a,b) => a+b, 0) / totalR;
    const top5Share = rs.slice(Math.floor(count * 0.95)).reduce((a,b) => a+b, 0) / totalR;
    
    trades.forEach(t => {
        if (t.r > 0) grossProfit += t.r;
        else grossLoss += Math.abs(t.r);
    });
    
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;
    
    console.log(`\n=== ${name} ===`);
    console.log(`Total Trades: ${count}`);
    console.log(`Independent (non-overlapping per symbol): ${independent}`);
    console.log(`Overlapping (ignored in real world?): ${overlapping}`);
    console.log(`Profit Factor: ${profitFactor.toFixed(3)}`);
    console.log(`Top 1% Win Share: ${(top1Share*100).toFixed(1)}%`);
    console.log(`Top 5% Win Share: ${(top5Share*100).toFixed(1)}%`);
});

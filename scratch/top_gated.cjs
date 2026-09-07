const fs = require('fs');
const tradesJson = JSON.parse(fs.readFileSync('backtest/output/trades.json', 'utf8'));

['stock_momentum_breakout', 'gap_and_go'].forEach(name => {
    const trades = tradesJson[name];
    if (!trades) return;
    
    // Sort descending by R
    trades.sort((a,b) => b.r - a.r);
    
    const count = trades.length;
    const top1Count = Math.floor(count * 0.01);
    const top5Count = Math.floor(count * 0.05);
    
    const top1 = trades.slice(0, top1Count);
    const top5 = trades.slice(0, top5Count);
    
    const top1Passed = top1.filter(t => t.gatePassed).length;
    const top5Passed = top5.filter(t => t.gatePassed).length;
    
    console.log(`\n=== ${name} ===`);
    console.log(`Top 1% (${top1Count} trades): ${top1Passed} passed the gate (${(top1Passed/top1Count*100).toFixed(1)}%)`);
    console.log(`Top 5% (${top5Count} trades): ${top5Passed} passed the gate (${(top5Passed/top5Count*100).toFixed(1)}%)`);
});

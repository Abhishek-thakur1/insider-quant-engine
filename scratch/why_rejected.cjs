const fs = require('fs');
const tradesJson = JSON.parse(fs.readFileSync('backtest/output/trades.json', 'utf8'));

const trades = tradesJson['stock_momentum_breakout'];
trades.sort((a,b) => b.r - a.r);
const top23 = trades.slice(0, 23);

console.log("Top 23 reasons for rejection:");
top23.forEach(t => {
    console.log(t.symbol + " | " + t.r.toFixed(2) + " R | passed: " + t.gatePassed + " | score: " + t.gateScore);
});

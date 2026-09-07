const fs = require('fs');
const tradesJson = JSON.parse(fs.readFileSync('backtest/output/trades.json', 'utf8'));

const trades = tradesJson['stock_momentum_breakout'];
if (!trades) {
    console.log('No trades found for stock_momentum_breakout');
    process.exit(1);
}

const scores = trades.map(t => t.gateScore).filter(s => s !== undefined).sort((a,b) => a - b);
const n = scores.length;

if (n === 0) {
    console.log('No gate scores found.');
    process.exit(1);
}

const mean = scores.reduce((a,b) => a+b, 0) / n;
const median = scores[Math.floor(n/2)];
const min = scores[0];
const max = scores[n-1];

console.log(`\n=== Stock Momentum Breakout Gate Score Distribution ===`);
console.log(`Total signals checked: ${n}`);
console.log(`Mean Score:   ${mean.toFixed(2)}`);
console.log(`Median Score: ${median}`);
console.log(`Min Score:    ${min}`);
console.log(`Max Score:    ${max}`);

// Buckets
const buckets = {
    '< 40': 0,
    '40-49': 0,
    '50-59': 0,
    '60-69': 0,
    '70-74': 0,
    '75-77': 0,
    '>= 78 (Passed)': 0
};

scores.forEach(s => {
    if (s < 40) buckets['< 40']++;
    else if (s < 50) buckets['40-49']++;
    else if (s < 60) buckets['50-59']++;
    else if (s < 70) buckets['60-69']++;
    else if (s < 75) buckets['70-74']++;
    else if (s < 78) buckets['75-77']++;
    else buckets['>= 78 (Passed)']++;
});

console.log('\nDistribution:');
for (const [k, v] of Object.entries(buckets)) {
    console.log(`${k.padEnd(15)}: ${v} trades (${(v/n*100).toFixed(1)}%)`);
}

const fs = require('fs');
let text = fs.readFileSync('backtest/data/fyersClient.ts', 'utf8');
text = text.replace(/\/rate\.\?limit\/i\.test/g, "/(rate|request).?limit/i.test");
fs.writeFileSync('backtest/data/fyersClient.ts', text);

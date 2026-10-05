import { redisClient } from './src/config/redis.js';

async function checkStaleTrades() {
  await redisClient.connect();
  const openKeys = await redisClient.hKeys('trades:open');
  console.log(`Total open trades in Redis: ${openKeys.length}`);
  
  let intradayCount = 0;
  let swingCount = 0;
  let staleIntradayCount = 0;
  
  const todayStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().split('T')[0];

  for (const key of openKeys) {
    const dataStr = await redisClient.hGet('trades:open', key);
    if (dataStr) {
      const pos = JSON.parse(dataStr);
      const isIntraday = !pos.durationClass || pos.durationClass === 'INTRADAY';
      const posDate = new Date(pos.timestamp + 5.5 * 3600 * 1000).toISOString().split('T')[0];
      
      if (isIntraday) {
        intradayCount++;
        if (posDate !== todayStr) {
          staleIntradayCount++;
          console.log(`Stale Intraday: ${pos.symbol} opened on ${posDate}`);
        }
      } else {
        swingCount++;
      }
    }
  }
  
  console.log(`\nSummary:`);
  console.log(`Total INTRADAY: ${intradayCount} (Stale: ${staleIntradayCount})`);
  console.log(`Total SWING: ${swingCount}`);
  
  process.exit(0);
}

checkStaleTrades();

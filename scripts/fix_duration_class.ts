import { pool } from '../src/config/db.js';

async function fixMistaggedTrades() {
  console.log('Connecting to Postgres to fix mistagged Stock Momentum Breakout trades...');
  try {
    const res = await pool.query(`
      UPDATE paper_trades
      SET duration_class = 'SWING'
      WHERE detector = 'Stock Momentum Breakout'
        AND duration_class = 'INTRADAY'
      RETURNING id, symbol, entry_time;
    `);
    
    console.log(`✅ Fixed ${res.rowCount} mistagged trades in paper_trades.`);
    for (const row of res.rows) {
      console.log(` - Trade ID ${row.id}: ${row.symbol} at ${row.entry_time}`);
    }
    
    // Check if we need to update any open trades in Redis
    console.log('\nChecking Redis for open trades...');
    const { redisClient } = await import('../src/config/redis.js');
    await redisClient.connect();
    
    const openKeys = await redisClient.hKeys('trades:open');
    let redisFixedCount = 0;
    
    for (const key of openKeys) {
      const dataStr = await redisClient.hGet('trades:open', key);
      if (dataStr) {
        const data = JSON.parse(dataStr);
        if (data.detectorName === 'Stock Momentum Breakout' && (!data.durationClass || data.durationClass === 'INTRADAY')) {
          data.durationClass = 'SWING';
          await redisClient.hSet('trades:open', key, JSON.stringify(data));
          redisFixedCount++;
        }
      }
    }
    console.log(`✅ Fixed ${redisFixedCount} mistagged open trades in Redis.`);
    
    await pool.end();
    await redisClient.quit();
    console.log('\nDone.');
  } catch (err) {
    console.error('Error fixing trades:', err);
  }
}

fixMistaggedTrades();

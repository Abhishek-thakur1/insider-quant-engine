import { pool } from './src/config/db.js';

async function auditFootprintDetectors() {
  console.log('Auditing Footprint Detectors...\n');
  try {
    const res = await pool.query(`
      SELECT detector, direction, entry_price, stop_price, target_price, status, realized_pnl, duration_class, entry_time 
      FROM paper_trades 
      WHERE detector IN ('Institutional OI Liquidity Sweep', 'Delta Hedging Pressure (Gamma Squeeze)')
      ORDER BY entry_time DESC;
    `);

    console.log(`Found ${res.rowCount} total trades for these detectors.`);
    
    let oiSweepCount = 0;
    let deltaCount = 0;
    let deltaSqueezeFlaws = 0;
    let oiSweepFlaws = 0;

    res.rows.forEach(row => {
      if (row.detector === 'Institutional OI Liquidity Sweep') oiSweepCount++;
      if (row.detector === 'Delta Hedging Pressure (Gamma Squeeze)') deltaCount++;

      // Check geometry (stop vs entry vs target)
      let isFlawed = false;
      const entry = Number(row.entry_price);
      const stop = Number(row.stop_price);
      const target = Number(row.target_price);

      if (row.direction === 'LONG') {
        if (stop >= entry || target <= entry) {
          isFlawed = true;
          console.log(`[FLAW] LONG ${row.detector} Trade: Entry=${entry}, Stop=${stop}, Target=${target}`);
        }
      } else if (row.direction === 'SHORT') {
        if (stop <= entry || target >= entry) {
          isFlawed = true;
          console.log(`[FLAW] SHORT ${row.detector} Trade: Entry=${entry}, Stop=${stop}, Target=${target}`);
        }
      }

      if (isFlawed) {
        if (row.detector === 'Institutional OI Liquidity Sweep') oiSweepFlaws++;
        if (row.detector === 'Delta Hedging Pressure (Gamma Squeeze)') deltaSqueezeFlaws++;
      }
    });

    console.log(`\nDelta Hedging Pressure (Gamma Squeeze): ${deltaCount} trades, ${deltaSqueezeFlaws} structural flaws.`);
    console.log(`Institutional OI Liquidity Sweep: ${oiSweepCount} trades, ${oiSweepFlaws} structural flaws.`);

    await pool.end();
  } catch (err) {
    console.error('Audit Error:', err);
  }
}

auditFootprintDetectors();

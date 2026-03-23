// import { VcpDetector } from '../detectors/vcpDetector.js';
// import { VolumeSpikeDetector } from '../detectors/volumeSpikeDetector.js';
// import type { IDetector } from '../core/types.js';
// import { bootRedis, redisClient } from '../config/redis.js';

// const runSimulation = async () => {
//     console.log("🎮 Booting Hedge-Fund Tier Market Simulator...");
//     await bootRedis();

//     const symbol = "NSE:ATGL-EQ";

//     await redisClient.del(`memory:vcp:${symbol}`);
//     await redisClient.del(`memory:volume:${symbol}`);
//     await redisClient.del(`cooldown:volume:${symbol}`);

//     const activeStrategies: IDetector[] = [
//         new VcpDetector(symbol, 5),
//         new VolumeSpikeDetector(symbol, 5)
//     ];

//     let tickCount = 0;
//     let currentPrice = 540.00;
//     let baseVolume = 1000;

//     const marketSimulation = setInterval(async () => {
//         tickCount++;
//         let simulatedTick = { price: 0, volume: 0 };

//         if (tickCount <= 6) {
//             currentPrice += (Math.random() > 0.5 ? 0.30 : -0.30);
//             simulatedTick = { price: currentPrice, volume: baseVolume + Math.floor(Math.random() * 200) };
//             console.log(`⏱️ [Tick ${tickCount}] ${symbol} | Price: ₹${simulatedTick.price.toFixed(2)} | Vol: ${simulatedTick.volume}`);
//         }
//         else if (tickCount === 7) {
//             console.log(`\n... 🐋 Whales entering the order book ...`);
//             simulatedTick = { price: currentPrice + 12.00, volume: baseVolume * 9 };
//             console.log(`🚀 [Tick ${tickCount}] ${symbol} | Price: ₹${simulatedTick.price.toFixed(2)} | Vol: ${simulatedTick.volume}`);
//         }
//         else {
//             console.log("🏁 Simulation Complete.");
//             clearInterval(marketSimulation);
//             await redisClient.quit();
//             return;
//         }

//         await Promise.all(activeStrategies.map(strategy => strategy.analyze(simulatedTick)));

//     }, 1000);
// };

// runSimulation();
import { VcpDetector } from '../detectors/vcpDetector.js';
import { VolumeSpikeDetector } from '../detectors/volumeSpikeDetector.js';
import type { IDetector } from '../core/types.js';

console.log("🎮 Booting Multi-Strategy Quant Simulator...");

const symbol = "NSE:ATGL-EQ";

// Array of active strategies monitoring the SAME stock
const activeStrategies: IDetector[] = [
    new VcpDetector(symbol, 5),
    new VolumeSpikeDetector(symbol, 5)
];

let tickCount = 0;
let currentPrice = 540.00;
let baseVolume = 1000;

const marketSimulation = setInterval(() => {
    tickCount++;
    let simulatedTick = { price: 0, volume: 0 };

    if (tickCount <= 6) {
        // Phase 1: Quiet Consolidation
        currentPrice += (Math.random() > 0.5 ? 0.30 : -0.30);
        simulatedTick = { price: currentPrice, volume: baseVolume + Math.floor(Math.random() * 200) };
        console.log(`⏱️ [Tick ${tickCount}] ${symbol} | Price: ₹${simulatedTick.price.toFixed(2)} | Vol: ${simulatedTick.volume}`);
    }
    else if (tickCount === 7) {
        // Phase 2: The Breakout!
        console.log(`\n... 🐋 Whales entering the order book ...`);
        simulatedTick = { price: currentPrice + 12.00, volume: baseVolume * 9 };
        console.log(`🚀 [Tick ${tickCount}] ${symbol} | Price: ₹${simulatedTick.price.toFixed(2)} | Vol: ${simulatedTick.volume}`);
    }
    else {
        console.log("🏁 Simulation Complete.");
        clearInterval(marketSimulation);
        return;
    }

    // 🧠 THE CORE ROUTER: Feed the live tick to EVERY active strategy
    activeStrategies.forEach(strategy => {
        strategy.analyze(simulatedTick);
    });

}, 1000);
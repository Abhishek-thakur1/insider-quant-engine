import { redisClient, bootRedis } from './config/redis.js';

const testMemoryBank = async () => {
    console.log("📡 Booting Redis connection...");
    await bootRedis();

    const symbol = "NSE:TEST-EQ";

    console.log(`\n💾 Pushing 3 ticks into the Redis List for ${symbol}...`);
    await redisClient.lPush(symbol, JSON.stringify({ price: 100, vol: 500 }));
    await redisClient.lPush(symbol, JSON.stringify({ price: 101, vol: 600 }));
    await redisClient.lPush(symbol, JSON.stringify({ price: 102, vol: 700 }));

    console.log("✂️ Trimming the list to keep only the latest 2 ticks (LTRIM)...");
    await redisClient.lTrim(symbol, 0, 1);

    const memory = await redisClient.lRange(symbol, 0, -1);

    console.log("\n🧠 Current State of Redis Memory:");
    console.log(memory.map(item => JSON.parse(item)));

    console.log("\n🧹 Cleaning up test data...");
    await redisClient.del(symbol);

    await redisClient.quit();
    console.log("🏁 Test Complete.");
};

testMemoryBank();
import { createClient } from 'redis';
import { ENV } from './env.js';

export const redisClient = createClient({
    socket: {
        host: ENV.REDIS_HOST,
        port: ENV.REDIS_PORT
    }
});

redisClient.on('error', (err) => console.error('❌ [Redis] Client Error:', err));
redisClient.on('connect', () => console.log('🟢 [Redis] Database Connection Established'));
redisClient.on('reconnecting', () => console.log('🛜 [Redis] Reconnecting...'));

export const bootRedis = async () => {
    if (!redisClient.isOpen) {
        await redisClient.connect();
    }
};
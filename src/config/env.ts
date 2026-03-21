import 'dotenv/config';

export const ENV = {
    // Fyers Credentials
    FYERS_APP_ID: process.env.FYERS_APP_ID || '',
    FYERS_SECRET_ID: process.env.FYERS_SECRET_ID || '',
    FYERS_REDIRECT_URI: process.env.FYERS_REDIRECT_URI || 'http://localhost:3000/callback',
    FYERS_PIN: process.env.FYERS_PIN || '',

    // Telegram Credentials
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',

    // Redis Credentials
    REDIS_HOST: process.env.REDIS_HOST || 'localhost',
    REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
};

// Fail fast if critical Telegram keys are missing
if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) {
    console.error("❌ CRITICAL: Telegram credentials missing in .env");
    process.exit(1);
}

// Fail fast if critical Fyers keys are missing
if (!ENV.FYERS_APP_ID || !ENV.FYERS_SECRET_ID || !ENV.FYERS_REDIRECT_URI) {
    console.error("❌ CRITICAL: Fyers API credentials missing in .env");
    process.exit(1);
}
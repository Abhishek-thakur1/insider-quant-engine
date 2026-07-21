import Fastify from 'fastify'
import fyers from 'fyers-api-v3'
import fs from 'fs'
import path from 'path'
import TelegramBot from 'node-telegram-bot-api'
import cron from 'node-cron'
import { ENV } from './env.js'

const fastify = Fastify({ logger: false })
// const TOKEN_PATH = path.resolve(process.cwd(), "access_token.txt");

// points to the shared Docker volume
const TOKEN_PATH = path.resolve('/app/token', 'access_token.txt')

const fyersApi = new fyers.fyersModel({ path: './', enableLogging: false })
fyersApi.setAppId(ENV.FYERS_APP_ID)
fyersApi.setRedirectUrl(ENV.FYERS_REDIRECT_URI)

// Initialize Telegram Bot
const bot = new TelegramBot(ENV.TELEGRAM_BOT_TOKEN, { polling: true })

console.log('\n[Auth Bridge] 🛡️  Telegram Auth Bridge Started.')
console.log(`[Auth Bridge] 📱 Send '/arm' to your Telegram bot to initiate login.\n`)

// ───THE ALARM CLOCK (Auto-Ping at 7:45 AM) ────────────────
const sendIgnitionPing = async () => {
	const authUrl = fyersApi.generateAuthCode()

	await bot.sendMessage(
		ENV.TELEGRAM_ADMIN_ID,
		`⏰ *Pre-Market Alert: 7:45 AM*\n\nThe market opens in 90 minutes. Tap the link below to authenticate via Fyers and arm the execution engine for the day.`,
		{
			parse_mode: 'Markdown',
			reply_markup: {
				inline_keyboard: [[{ text: 'Log in to Fyers', url: authUrl }]],
			},
		},
	)
	console.log('[Auth Bridge] 📤 7:45 AM Auto-Ping sent to Telegram.')
}

// cron.schedule("45 7 * * 1-5", () => {
//     sendIgnitionPing();
// }, {
//     timezone: "Asia/Kolkata"
// });

sendIgnitionPing()

// ─── TELEGRAM LISTENER: Manual Override ────────────────────
bot.onText(/\/arm/, async (msg) => {
	if (msg.chat.id.toString() !== ENV.TELEGRAM_ADMIN_ID) {
		console.log('[Debug] ❌ SECURITY BLOCK: Chat ID mismatch. Ignoring intruder.')
		return // Drops the message silently
	}

	const authUrl = fyersApi.generateAuthCode()

	await bot.sendMessage(
		ENV.TELEGRAM_ADMIN_ID,
		`🔐 *Engine Ignition Sequence*\n\nTap the link below to authenticate via Fyers. The engine is waiting for the cryptographic payload.`,
		{
			parse_mode: 'Markdown',
			reply_markup: {
				inline_keyboard: [[{ text: 'Log in to Fyers', url: authUrl }]],
			},
		},
	)
	console.log('[Auth Bridge] 📤 Manual Ignition link sent to Telegram.')
})

// ─── FASTIFY SERVER: Catch the Fyers Redirect ──────────────
fastify.get('/callback', async (request, reply) => {
	const { auth_code, error } = request.query as { auth_code?: string; error?: string }

	if (error) {
		await bot.sendMessage(ENV.TELEGRAM_ADMIN_ID, `❌ *Auth Failed:* ${error}`, {
			parse_mode: 'Markdown',
		})
		return reply.status(400).send('Authentication failed. Check Telegram.')
	}

	if (auth_code) {
		console.log('[Auth Bridge] 📥 Payload intercepted. Forging token...')

		try {
			const response = await fyersApi.generate_access_token({
				client_id: ENV.FYERS_APP_ID,
				secret_key: ENV.FYERS_SECRET_ID,
				auth_code: auth_code,
			})

			if (response.s === 'ok') {
				fs.writeFileSync(TOKEN_PATH, response.access_token)

				await bot.sendMessage(
					ENV.TELEGRAM_ADMIN_ID,
					`✅ *Token Forged Successfully*\n\nThe core engine is armed and mathematically synced. Ready for market open.`,
					{ parse_mode: 'Markdown' },
				)

				console.log('[Auth Bridge] 🟢 Token written to disk. Shutting down bridge.')
				reply.send('Handshake complete. You can close this window.')

				// Clean shutdown
				setTimeout(() => process.exit(0), 1000)
			} else {
				throw new Error(response.message || 'Unknown Fyers API error')
			}
		} catch (err: any) {
			console.error('[Auth Bridge] ❌ Token Generation Error:', err)
			await bot.sendMessage(ENV.TELEGRAM_ADMIN_ID, `❌ *Error Forging Token:* ${err.message}`, {
				parse_mode: 'Markdown',
			})
			reply.status(500).send('Failed to generate token.')
		}
	} else {
		reply.status(400).send('No auth_code provided.')
	}
})

fastify.listen({ port: parseInt(ENV.PORT || '3000'), host: '0.0.0.0' }, (err) => {
	if (err) {
		console.error(err)
		process.exit(1)
	}
})

// import Fastify from 'fastify';
// import fyersApi from 'fyers-api-v3';
// import fs from 'fs';
// import path from 'path';
// import { fileURLToPath } from 'url';
// import { ENV } from './env.js';

// const fastify = Fastify({ logger: false });
// const TOKEN_PATH = path.resolve(process.cwd(), 'access_token.txt');

// const fyers = new fyersApi.fyersModel({ path: "./", enableLogging: false });

// fyers.setAppId(ENV.FYERS_APP_ID);
// fyers.setRedirectUrl(ENV.FYERS_REDIRECT_URI);

// export const generateLoginUrl = () => {
//     const authUrl = fyers.generateAuthCode();
//     console.log(`\n\n🔗 [ACTION REQUIRED] Click this link to log in and authorize the engine:`);
//     console.log(`\n${authUrl}\n`);
// };

// export const startAuthServer = async () => {
//     fastify.get('/callback', async (request, reply) => {
//         const { auth_code, s } = request.query as any;

//         if (s === 'ok' && auth_code) {
//             console.log(`[Auth] 🟢 Auth code received! Exchanging for Access Token...`);

//             try {
//                 const response = await fyers.generate_access_token({
//                     client_id: ENV.FYERS_APP_ID,
//                     secret_key: ENV.FYERS_SECRET_ID,
//                     auth_code: auth_code
//                 });

//                 if (response.s === 'ok') {
//                     fs.writeFileSync(TOKEN_PATH, response.access_token);
//                     console.log(`[Auth] 🏆 SUCCESS! Access Token saved to access_token.txt`);

//                     setTimeout(() => process.exit(0), 1000);
//                     return reply.send("Authentication Successful! You can close this tab and check your terminal.");
//                 } else {
//                     console.error(`[Auth] ❌ Failed to generate token:`, response);
//                     return reply.code(500).send("Failed to generate access token.");
//                 }
//             } catch (error) {
//                 console.error(`[Auth] ❌ Error during token exchange:`, error);
//                 return reply.code(500).send("Internal Server Error");
//             }
//         } else {
//             return reply.code(400).send("Invalid callback request.");
//         }
//     });

//     try {
//         await fastify.listen({ port: 3000 });
//         console.log(`[Auth] 📡 Temporary Auth Server listening on http://localhost:3000`);
//         generateLoginUrl();
//     } catch (err) {
//         fastify.log.error(err);
//         process.exit(1);
//     }
// };

// const currentFilePath = fileURLToPath(import.meta.url);
// if (process.argv[1] === currentFilePath) {
//     startAuthServer();
// }

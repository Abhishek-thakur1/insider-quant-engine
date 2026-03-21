import Fastify from 'fastify';
import fyersApi from 'fyers-api-v3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ENV } from './env.js';

const fastify = Fastify({ logger: false });
const TOKEN_PATH = path.resolve(process.cwd(), 'access_token.txt');

const fyers = new fyersApi.fyersModel({ path: "./", enableLogging: false });

fyers.setAppId(ENV.FYERS_APP_ID);
fyers.setRedirectUrl(ENV.FYERS_REDIRECT_URI);

export const generateLoginUrl = () => {
    const authUrl = fyers.generateAuthCode();
    console.log(`\n\n🔗 [ACTION REQUIRED] Click this link to log in and authorize the engine:`);
    console.log(`\n${authUrl}\n`);
};

export const startAuthServer = async () => {
    fastify.get('/callback', async (request, reply) => {
        const { auth_code, s } = request.query as any;

        if (s === 'ok' && auth_code) {
            console.log(`[Auth] 🟢 Auth code received! Exchanging for Access Token...`);

            try {
                const response = await fyers.generate_access_token({
                    client_id: ENV.FYERS_APP_ID,
                    secret_key: ENV.FYERS_SECRET_ID,
                    auth_code: auth_code
                });

                if (response.s === 'ok') {
                    fs.writeFileSync(TOKEN_PATH, response.access_token);
                    console.log(`[Auth] 🏆 SUCCESS! Access Token saved to access_token.txt`);

                    setTimeout(() => process.exit(0), 1000);
                    return reply.send("Authentication Successful! You can close this tab and check your terminal.");
                } else {
                    console.error(`[Auth] ❌ Failed to generate token:`, response);
                    return reply.code(500).send("Failed to generate access token.");
                }
            } catch (error) {
                console.error(`[Auth] ❌ Error during token exchange:`, error);
                return reply.code(500).send("Internal Server Error");
            }
        } else {
            return reply.code(400).send("Invalid callback request.");
        }
    });

    try {
        await fastify.listen({ port: 3000 });
        console.log(`[Auth] 📡 Temporary Auth Server listening on http://localhost:3000`);
        generateLoginUrl();
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFilePath) {
    startAuthServer();
}
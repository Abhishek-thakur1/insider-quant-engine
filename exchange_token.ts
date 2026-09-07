import fs from 'fs'
import fyers from 'fyers-api-v3'
import { ENV } from './src/config/env.js'

async function run() {
    const fyersApi = new fyers.fyersModel({ path: './', enableLogging: true })
    const authCode = fs.readFileSync('access_token.txt', 'utf8').trim()
    console.log("Using auth_code:", authCode.substring(0, 20) + '...')
    try {
        const response = await fyersApi.generate_access_token({
            client_id: ENV.FYERS_APP_ID,
            secret_key: ENV.FYERS_SECRET_ID,
            auth_code: authCode
        })
        console.log("Response:", response)
        if (response.s === 'ok' && response.access_token) {
            fs.writeFileSync('access_token.txt', response.access_token)
            console.log("Wrote access_token to access_token.txt")
        }
    } catch (e) {
        console.error(e)
    }
}
run()

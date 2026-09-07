import 'dotenv/config'
import fyers from 'fyers-api-v3'
import fs from 'fs'

const fyersApi = new fyers.fyersModel({ path: './', enableLogging: true })
fyersApi.setAppId(process.env.FYERS_APP_ID!)
fyersApi.setAccessToken(fs.readFileSync('N:/trade/insider-quant-engine/access_token.txt', 'utf8').trim())

async function main() {
    try {
        const response = await fyersApi.getHistory({
            symbol: 'NSE:NIFTY50-INDEX',
            resolution: 'D',
            date_format: '1',
            range_from: '2025-12-09',
            range_to: '2026-09-05',
            cont_flag: '1'
        })
        console.log("Success:", response)
    } catch (e) {
        console.error("Error:", JSON.stringify(e, null, 2))
    }
}
main()

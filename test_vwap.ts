import { getMemoryRedis } from './backtest/core/memoryRedis.js'
import { updateVwap, getVwap } from './src/utils/vwapUtils.js'
import { setVirtualNow } from './backtest/core/clock.js'

async function main() {
    setVirtualNow(Date.now())
    const redis = getMemoryRedis()
    redis.flushAll()

    await updateVwap('NSE:NIFTY50-INDEX', 25000, 1, 25010, 24990)
    const vwap = await getVwap('NSE:NIFTY50-INDEX')
    console.log("VWAP:", vwap)
}
main()

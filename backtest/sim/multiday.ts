import { type RawSignal } from '../replay/engine.js'
import { type SimulatedTrade, deriveLevels, type ExitReason } from './exit.js'
import { loadSeries, type Bar } from '../data/store.js'
import { DATA, SIM } from '../config.js'
import { looksCircuitLocked } from '../replay/barToTicks.js'
import { istDateStringOf } from '../core/clock.js'

export const MULTIDAY_DETECTORS = ['Stock Momentum Breakout']

type PositionStage = 'full' | 'scaled' | 'trailing'

export interface MultidayPosition {
    signal: RawSignal
    underlying: string
    side: 'LONG' | 'SHORT'
    entryPrice: number
    entryTs: number
    stage: PositionStage
    stopLevel: number
    targetLevel: number
    daysHeld: number
    basis: string
    scaleOutPrice?: number
}

class MultidayLedger {
    positions: MultidayPosition[] = []

    add(signal: RawSignal, underlying: string) {
        // [FIX - Pyramiding Contamination] Max 1 open position per symbol
        if (this.positions.some(p => p.underlying === underlying)) {
            return
        }

        const levels = deriveLevels(signal)
        this.positions.push({
            signal,
            underlying,
            side: signal.payload.side,
            entryPrice: signal.payload.price,
            entryTs: signal.ts,
            stage: 'full',
            stopLevel: levels.stop,
            targetLevel: levels.target,
            daysHeld: 0,
            basis: levels.basis
        })
    }

    getEma(bars: Bar[], period: number, currentDayStr: string): number | null {
        const history = bars.filter(b => istDateStringOf(b.t) <= currentDayStr)
        if (history.length < period) return null
        
        const k = 2 / (period + 1)
        let sum = 0
        for (let i = 0; i < period; i++) sum += history[i]!.c
        let ema = sum / period
        
        for (let i = period; i < history.length; i++) {
            ema = (history[i]!.c * k) + (ema * (1 - k))
        }
        return ema
    }

    applySlippage(price: number, side: 'LONG' | 'SHORT', leg: 'entry' | 'exit'): number {
        const factor = SIM.slippageBps / 10_000
        const adverse = leg === 'entry' ? (side === 'LONG' ? 1 : -1) : side === 'LONG' ? -1 : 1
        return price * (1 + adverse * factor)
    }

    evaluateEndOfDay(currentDayStr: string, currentDayTs: number): SimulatedTrade[] {
        const closed: SimulatedTrade[] = []
        
        for (let i = this.positions.length - 1; i >= 0; i--) {
            const pos = this.positions[i]!
            const entryDate = istDateStringOf(pos.entryTs)
            
            if (entryDate !== currentDayStr) {
                pos.daysHeld++
            }
            
            const dailySeries = loadSeries(pos.underlying, DATA.dailyResolution)
            if (!dailySeries) continue
            
            const ema10 = this.getEma(dailySeries.bars, 10, currentDayStr)
            if (!ema10) continue
            
            const todayBar = dailySeries.bars.find(b => istDateStringOf(b.t) === currentDayStr)
            if (!todayBar) continue

            if (SIM.circuitLockZeroRange && looksCircuitLocked(todayBar)) {
                continue
            }

            const isLong = pos.side === 'LONG'
            let exitPrice: number | null = null
            let exitReason: ExitReason | null = null

            // Scale-out / breakeven
            if (pos.daysHeld >= 3 && pos.stage === 'full') {
                const isProfitable = isLong ? todayBar.c > pos.entryPrice : todayBar.c < pos.entryPrice
                if (isProfitable) {
                    pos.scaleOutPrice = todayBar.c
                    pos.stage = 'scaled'
                    pos.stopLevel = pos.entryPrice
                } else if (pos.daysHeld >= 5) {
                    pos.scaleOutPrice = todayBar.c
                    pos.stage = 'scaled'
                    pos.stopLevel = pos.entryPrice
                }
            }

            // Stops
            let hardStopBreached = false
            if (pos.daysHeld === 0) {
                const intradaySeries = loadSeries(pos.underlying, DATA.intradayResolution)
                if (intradaySeries) {
                    const forwardBars = intradaySeries.bars.filter(b => b.t > pos.entryTs && istDateStringOf(b.t) === currentDayStr)
                    for (const b of forwardBars) {
                        if (isLong && b.l <= pos.stopLevel) {
                            hardStopBreached = true
                            break
                        }
                        if (!isLong && b.h >= pos.stopLevel) {
                            hardStopBreached = true
                            break
                        }
                    }
                } else {
                    hardStopBreached = isLong ? todayBar.c <= pos.stopLevel : todayBar.c >= pos.stopLevel
                }
            } else {
                hardStopBreached = isLong ? todayBar.l <= pos.stopLevel : todayBar.h >= pos.stopLevel
            }
                
            const emaBreached = isLong ? todayBar.c < ema10 : todayBar.c > ema10

            if (hardStopBreached) {
                exitPrice = pos.stopLevel
                exitReason = 'stop'
            } else if (emaBreached) {
                exitPrice = todayBar.c
                exitReason = 'stop'
            }

            if (exitPrice !== null && exitReason !== null) {
                const entryFill = this.applySlippage(pos.entryPrice, pos.side, 'entry')
                let finalExitFill = this.applySlippage(exitPrice, pos.side, 'exit')
                
                if (pos.scaleOutPrice) {
                    const scaledFill = this.applySlippage(pos.scaleOutPrice, pos.side, 'exit')
                    finalExitFill = (finalExitFill + scaledFill) / 2
                }

                const originalRisk = Math.abs(pos.entryPrice - deriveLevels(pos.signal).stop)
                const pnlPerUnit = isLong ? finalExitFill - entryFill : entryFill - finalExitFill
                const r = originalRisk > 0 ? pnlPerUnit / originalRisk : 0
                
                closed.push({
                    detectorId: pos.signal.detectorId,
                    sessionDate: pos.signal.sessionDate,
                    symbol: pos.signal.payload.symbol,
                    underlying: pos.underlying,
                    side: pos.side,
                    entryTs: pos.signal.ts,
                    exitTs: todayBar.t,
                    entryPrice: entryFill,
                    exitPrice: finalExitFill,
                    stopLevel: pos.stopLevel,
                    targetLevel: pos.targetLevel,
                    r,
                    exitReason,
                    exitBasis: pos.basis as any,
                    holdingMinutes: pos.daysHeld * 375,
                    deferredByLock: 0,
                    t2Reached: false,
                    gateScore: pos.signal.gate?.score ?? 0,
                    gatePassed: pos.signal.gate?.passed ?? false
                })
                
                this.positions.splice(i, 1)
            }
        }
        return closed
    }

    forceCloseAll(finalDayStr: string): SimulatedTrade[] {
        const closed: SimulatedTrade[] = []
        for (const pos of this.positions) {
            const dailySeries = loadSeries(pos.underlying, DATA.dailyResolution)
            if (!dailySeries) continue
            const todayBar = dailySeries.bars.find(b => istDateStringOf(b.t) === finalDayStr)
            if (!todayBar) continue

            const exitPrice = todayBar.c
            const entryFill = this.applySlippage(pos.entryPrice, pos.side, 'entry')
            let finalExitFill = this.applySlippage(exitPrice, pos.side, 'exit')
            if (pos.scaleOutPrice) {
                const scaledFill = this.applySlippage(pos.scaleOutPrice, pos.side, 'exit')
                finalExitFill = (finalExitFill + scaledFill) / 2
            }
            const originalRisk = Math.abs(pos.entryPrice - deriveLevels(pos.signal).stop)
            const pnlPerUnit = pos.side === 'LONG' ? finalExitFill - entryFill : entryFill - finalExitFill
            const r = originalRisk > 0 ? pnlPerUnit / originalRisk : 0

            closed.push({
                detectorId: pos.signal.detectorId,
                sessionDate: pos.signal.sessionDate,
                symbol: pos.signal.payload.symbol,
                underlying: pos.underlying,
                side: pos.side,
                entryTs: pos.signal.ts,
                exitTs: todayBar.t,
                entryPrice: entryFill,
                exitPrice: finalExitFill,
                stopLevel: pos.stopLevel,
                targetLevel: pos.targetLevel,
                r,
                exitReason: 'session-end',
                exitBasis: pos.basis as any,
                holdingMinutes: pos.daysHeld * 375,
                deferredByLock: 0,
                t2Reached: false,
                gateScore: pos.signal.gate?.score ?? 0,
                gatePassed: pos.signal.gate?.passed ?? false
            })
        }
        this.positions = []
        return closed
    }
}

export const globalMultidayLedger = new MultidayLedger()

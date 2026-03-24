export interface UniverseSymbol {
    fyersToken: string;
    symbol: string;
    exchange: string;
    segment: string;
}

export interface TickData {
    price: number;
    volume: number;
    timestamp: number;
}

export interface IDetector {
    name: string;
    symbol: string;
    analyze(liveTick: TickData): Promise<void>;
}

export type MarketBias = "bullish" | "bearish" | "neutral";

export interface VwapState {
    cumulativePV: number;
    cumulativeVol: number;
    vwap: number;
}

export type TradeSide = 'LONG' | 'SHORT';

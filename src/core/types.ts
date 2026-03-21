
export interface UniverseSymbol {
    fyersToken: string;
    symbol: string;
    exchange: string;
    segment: string;
}


export interface TickData {
    price: number;
    volume: number;
}

export interface IDetector {
    name: string;
    symbol: string;
    analyze(liveTick: TickData): Promise<void>;
}
// ============================================================
// backtest/trendDay.ts — session labels for the Nifty trend-day study (pure)
//
// Thresholds live in config/trend_day.json and were committed BEFORE the first
// study run (see git history). They are never tuned against results; a change is
// a second, labelled study.
// ============================================================

import fs from 'node:fs'
import path from 'node:path'

export type SessionLabel = 'trend-down' | 'trend-up' | 'chop'
export interface TrendDayConfig {
	bodyFraction: number
	closeFraction: number
}

export const loadTrendDayConfig = (file = path.resolve(process.cwd(), 'config', 'trend_day.json')): TrendDayConfig => {
	const c = JSON.parse(fs.readFileSync(file, 'utf8')) as TrendDayConfig
	if (!(c.bodyFraction > 0 && c.bodyFraction <= 1) || !(c.closeFraction > 0 && c.closeFraction < 0.5)) throw new Error('config/trend_day.json: bodyFraction in (0,1], closeFraction in (0,0.5)')
	return c
}

export const labelSession = (bar: { o: number; h: number; l: number; c: number }, cfg: TrendDayConfig): SessionLabel => {
	const r = bar.h - bar.l
	if (!(r > 0)) return 'chop'
	const body = bar.c - bar.o
	if (body <= -cfg.bodyFraction * r && bar.c - bar.l <= cfg.closeFraction * r) return 'trend-down'
	if (body >= cfg.bodyFraction * r && bar.h - bar.c <= cfg.closeFraction * r) return 'trend-up'
	return 'chop'
}

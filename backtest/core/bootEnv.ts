// ============================================================
// backtest/core/bootEnv.ts — MUST be the first import of any backtest entry
//
// `src/config/env.ts` calls process.exit(1) when Telegram or Fyers credentials
// are absent. That is right for the live engine and wrong for a backtest: a
// synthetic run needs no credentials at all, and a data fetch needs only the
// Fyers ones.
//
// ORDER MATTERS. ESM evaluates imported modules in import order, so importing
// this module first means its body runs before anything that pulls in env.ts.
//
// dotenv is loaded HERE, before the placeholders are applied, and dotenv does
// not overwrite variables that already exist — so a real .env always wins and
// the placeholders only fill what is genuinely missing. Getting that order
// wrong would let a placeholder shadow a real credential.
// ============================================================

import 'dotenv/config'

export const PLACEHOLDER = 'BACKTEST_PLACEHOLDER'

const fill = (name: string): void => {
	if (!process.env[name]) process.env[name] = PLACEHOLDER
}

// Telegram: never used by the backtest. The seam intercepts before dispatch and
// run.ts refuses to start without BACKTEST_MODE=true, so nothing can be sent.
fill('TELEGRAM_BOT_TOKEN')
fill('TELEGRAM_CHANNEL_ID')
fill('TELEGRAM_ADMIN_ID')

// Fyers: needed for `fetch` only. authenticate() rejects the placeholder with a
// clear message rather than issuing a doomed API call.
fill('FYERS_APP_ID')
fill('FYERS_SECRET_ID')
if (!process.env['FYERS_REDIRECT_URI']) {
	process.env['FYERS_REDIRECT_URI'] = 'http://localhost:3000/callback'
}

/** True when a value came from the placeholder rather than the environment. */
export const isPlaceholder = (name: string): boolean => process.env[name] === PLACEHOLDER

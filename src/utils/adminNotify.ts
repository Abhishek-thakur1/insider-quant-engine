// ============================================================
// utils/adminNotify.ts — best-effort Telegram message to the ADMIN chat
//
// Ops notices only (watchdog trips, stale holiday calendar). Never the public
// channel. Bounded by a timeout and never throws: callers use it on exit paths.
// ============================================================

import { ENV } from '../config/env.js'

export const notifyAdmin = async (text: string, timeoutMs = 4000): Promise<boolean> => {
	if (!ENV.TELEGRAM_ADMIN_ID) {
		console.warn('[AdminNotify] TELEGRAM_ADMIN_ID not set — notice not sent:', text)
		return false
	}
	try {
		const res = await fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chat_id: ENV.TELEGRAM_ADMIN_ID, text }),
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!res.ok) console.error(`[AdminNotify] Telegram responded ${res.status}`)
		return res.ok
	} catch (err) {
		console.error('[AdminNotify] send failed:', (err as Error)?.message ?? err)
		return false
	}
}

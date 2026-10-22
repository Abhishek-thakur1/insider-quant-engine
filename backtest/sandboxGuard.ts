// ============================================================
// backtest/sandboxGuard.ts — first command of scripts/replay_sandbox.sh
//
// Exits non-zero (and the replay never starts) unless: BACKTEST_MODE=true, no
// credential-like env var (DB, Redis, Telegram, Fyers, AWS), no Fyers token file,
// and no network (a DNS lookup of api.telegram.org must fail: --network none).
// ============================================================

import dns from 'node:dns/promises'
import fs from 'node:fs'
import { sandboxViolations } from './fetchReplay.js'

const TOKEN_PATHS = ['/app/token/access_token.txt', 'access_token.txt', 'backtest/access_token.txt']

const main = async (): Promise<number> => {
	const v = sandboxViolations(process.env, TOKEN_PATHS.some((p) => fs.existsSync(p)))
	try {
		await dns.lookup('api.telegram.org')
		v.push('network reachable (api.telegram.org resolved): run with --network none')
	} catch {
		// expected inside the sandbox
	}
	if (v.length > 0) {
		console.error(`[sandbox] ⛔ refusing to run the replay:\n  - ${v.join('\n  - ')}`)
		return 1
	}
	console.log('[sandbox] ✅ no network, no credentials, BACKTEST_MODE=true')
	return 0
}

main().then((c) => process.exit(c))

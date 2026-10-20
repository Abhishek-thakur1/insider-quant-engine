// ============================================================
// alertPipeline.ts — the body of sendTelegramAlert, with its I/O injected
//
// Moved out of telegramWorker.ts unchanged in behaviour so it can be tested
// without env, Redis, Postgres or Telegram (config/env.ts exits the process
// when credentials are missing). telegramWorker.ts wires in the live deps.
//
// The optional `obs` draft is OBSERVATION ONLY: the pipeline writes facts into
// it (through `note`, which swallows any error) and never reads from it, so
// recording a signal cannot change what is traded or alerted.
// tests/alertPipeline.test.ts proves this by running every scenario with no
// draft, with a draft, and with a draft that throws on every write.
// ============================================================

import type { FilterDecision } from '../detectors/janeStreetFilter.js'
import type { OpenPosition } from '../core/positionTracker.js'
import type { AlertPayload } from './telegramWorker.js'
import type { SignalDraft } from '../db/signalRecord.js'
import {
	buildEquityMessage,
	computeSizing,
	dispatchBlockReason,
	getISTDateString,
	releaseAlertSlot,
	reserveAlertSlot,
	type AlertStore,
} from './alertPolicy.js'

// Gates that represent a structural/mathematical disqualification of the
// signal (wrong regime, negative EV, failed Bayesian confidence, Kelly sizing
// says don't take it) — these must NEVER dispatch, even in shadow mode.
// Shadow mode is only meant to relax the aggregate SCORE threshold so we can
// calibrate where that cutoff should sit; it is not a bypass for gates that
// mean the trade is mathematically unsound.
//
// IMPORTANT: confirm these strings exactly match the values janeStreetFilter.ts
// assigns to `decision.rejectedAt` before relying on this list.
const HARD_GATES = new Set(['REGIME', 'BAYESIAN', 'EV', 'KELLY'])

export interface PipelineTracker {
	getCurrentNotional(): number
	registerTrade(pos: OpenPosition): Promise<number | null>
}

export interface PipelineDeps {
	runFilter(data: AlertPayload): Promise<FilterDecision>
	// Lazily resolved, exactly when the original code dynamically imported them.
	getTracker(): Promise<PipelineTracker>
	getAlertStore(): Promise<AlertStore>
	sendChannel(text: string, markdown: boolean): Promise<unknown>
	sendAdmin(text: string): Promise<unknown>
	now(): number
	config: {
		shadowMode: boolean
		maxAlertsPerDay: number
		capitalBase: number
		capitalBehavior: string
		hasAdmin: boolean
	}
}

/** Write into the observation draft. Any failure is swallowed — observation must never affect the outcome. */
const note = (obs: SignalDraft | null, write: (d: SignalDraft) => void): void => {
	if (!obs) return
	try {
		write(obs)
	} catch {
		// deliberately ignored
	}
}

export const runAlertPipeline = async (
	data: AlertPayload,
	deps: PipelineDeps,
	obs: SignalDraft | null = null,
): Promise<void> => {
	const { config } = deps

	// ── CONFIRMATION ENGINE GATE ─────────────────────────────────────────────
	let decision: FilterDecision | null = null

	try {
		decision = await deps.runFilter(data)
		const d = decision
		note(obs, (o) => {
			o.decision = d
		})

		const isHardGateRejection = !!decision.rejectedAt && HARD_GATES.has(decision.rejectedAt)

		// Not recorded: outright failed outside shadow mode, OR failed on a hard
		// gate regardless of shadow mode. (Pre-existing behaviour, unchanged;
		// the signals table logs these.)
		if (!decision.passed && (isHardGateRejection || !config.shadowMode)) {
			console.log(
				`🚫 [${data.side}] ${data.symbol} blocked — score ${decision.score}/100 (${decision.rejectedAt ?? 'below threshold'})${
					isHardGateRejection && config.shadowMode
						? ' [hard gate — shadow mode does not override]'
						: ''
				}`,
			)
			note(obs, (o) => {
				o.suppressed = 'FILTER_REJECTED'
			})
			return
		}
	} catch (filterErr) {
		// Fail open for RECORDING: a bug in the confirmation layer must never
		// silently drop the signal from the data set. It is recorded as ungated
		// and is NOT sent to the channel (alert policy: gated-only).
		console.error(
			'[Confirmation Engine] ⚠️ Error — recording signal as ungated, not alerting:',
			filterErr,
		)
		note(obs, (o) => {
			o.filterError = true
		})
	}
	// ── END CONFIRMATION GATE ──────────────────────────────────────────────

	try {
		const isLong = data.side === 'LONG'
		const isOptions = data.symbol.endsWith('CE') || data.symbol.endsWith('PE')
		const entry = data.price
		const durationClass = data.durationClass || 'INTRADAY'

		// Levels — computed ONCE; the same numbers are tracked in Postgres and
		// shown in the message.
		let stopLoss: number
		let target1: number
		let target2: number

		if (!isOptions) {
			stopLoss = isLong
				? Number((data.vwap * 0.998).toFixed(2))
				: Number((data.vwap * 1.002).toFixed(2))
			const risk = Math.abs(entry - stopLoss)
			target1 = isLong
				? Number((entry + risk * 1.5).toFixed(2))
				: Number((entry - risk * 1.5).toFixed(2))
			target2 = isLong
				? Number((entry + risk * 2.5).toFixed(2))
				: Number((entry - risk * 2.5).toFixed(2))
		} else {
			// Option alerts embed index-level SL/T1 in the trigger text.
			const slMatch = data.trigger.match(/SL ₹(\d+(\.\d+)?)/)
			const t1Match = data.trigger.match(/T1 ₹(\d+(\.\d+)?)/)
			stopLoss = slMatch ? Number(slMatch[1]) : isLong ? entry * 0.9 : entry * 1.1
			target1 = t1Match ? Number(t1Match[1]) : isLong ? entry * 1.2 : entry * 0.8
			target2 = target1
		}
		const lv = { entry, stopLoss, target1 }
		note(obs, (o) => {
			o.levels = lv
		})

		// Capital-constrained position sizing
		const positionTracker = await deps.getTracker()
		const sizing = computeSizing({
			entry,
			stopLoss,
			capitalBase: config.capitalBase,
			currentNotional: positionTracker.getCurrentNotional(),
			behavior: config.capitalBehavior,
		})
		note(obs, (o) => {
			o.sizing = { ...sizing }
		})
		if (sizing.capitalGated) {
			console.warn(
				`[PositionSizing] ${data.symbol}: capital-gated — qty ${sizing.qty} → ${sizing.actualSize}${sizing.skip ? ' (skipped)' : ' (reduced)'}`,
			)
		}

		const gated = decision?.passed ?? false

		// Record EVERY trade that reaches this point, before any alert decision.
		const tradeId = await positionTracker.registerTrade({
			id: `trade_${deps.now()}_${data.symbol}`,
			symbol: data.symbol,
			side: data.side,
			entryPrice: entry,
			stopLoss,
			target: target1, // We track Target 1 for the PnL hit
			timestamp: deps.now(),
			detectorName: data.detectorName || 'UNKNOWN',
			size: sizing.qty, // Full unconstrained size for historical significance testing
			regimeClass: data.regimeClass || decision?.regime || 'UNIVERSAL',
			gated,
			capitalGated: sizing.capitalGated,
			actualSize: sizing.actualSize,
			durationClass,
		})
		note(obs, (o) => {
			o.tradeRegistered = true
			o.tradeId = tradeId
		})

		// ── ALERT POLICY (Telegram only — never affects what is recorded) ──────
		const block = dispatchBlockReason({
			gated,
			skip: sizing.skip,
			actualSize: sizing.actualSize,
			isOption: isOptions,
		})
		if (block) {
			console.log(`🔕 [${data.side}] ${data.symbol} recorded, not alerted (${block})`)
			note(obs, (o) => {
				o.suppressed = block
			})
			return
		}

		const alertStore = await deps.getAlertStore()
		const slotArgs = {
			day: getISTDateString(deps.now()),
			detector: data.detectorName || 'UNKNOWN',
			symbol: data.symbol,
		}
		const slot = await reserveAlertSlot(alertStore, {
			...slotArgs,
			maxPerDay: config.maxAlertsPerDay,
		})
		if (slot.action === 'DUPLICATE') {
			console.log(
				`🔕 [${data.side}] ${data.symbol} recorded, not alerted (already alerted today for ${slotArgs.detector})`,
			)
			note(obs, (o) => {
				o.suppressed = 'DUPLICATE'
			})
			return
		}
		if (slot.action === 'CAP_REACHED') {
			console.log(
				`🔕 [${data.side}] ${data.symbol} recorded, not alerted (daily cap ${config.maxAlertsPerDay} reached)`,
			)
			note(obs, (o) => {
				o.suppressed = 'CAP_REACHED'
			})
			if (slot.notifyCap && config.hasAdmin) {
				deps
					.sendAdmin(
						`ℹ️ Daily alert cap (${config.maxAlertsPerDay}) reached. Further signals today are recorded but not sent.`,
					)
					.catch((e) => console.error('[TelegramWorker] cap notice failed:', e))
			}
			return
		}

		const scoreLines = decision
			? `\n\n🧮 *Confirmation Score: ${decision.score}/100*\n• Regime: ${decision.regime} (H=${decision.entropy.toFixed(2)})\n• Bayesian P(win): ${(decision.posterior * 100).toFixed(0)}%\n• EV: ₹${decision.ev.toFixed(0)}`
			: ''

		let message: string
		if (isOptions) {
			const directionEmoji = isLong ? '📈' : '📉'
			message = `
🚨 *NIFTY SNIPER SETUP* 🚨

${directionEmoji} *Action:* BUY ${data.symbol}
📊 *Index Level:* ₹${data.price}

*⚡ The Edge:*
• ${data.trigger.replace(/\|/g, '\n• ')}${scoreLines}

⏳ *Horizon:* Intraday Scalp
⚠️ _Options decay fast. Stick to the Stop Loss._
            `.trim()
		} else {
			message = buildEquityMessage({
				symbol: data.symbol,
				side: data.side,
				trigger: data.trigger,
				volumeSpikeRatio: data.volumeSpikeRatio,
				entry,
				stopLoss,
				target1,
				target2,
				qty: sizing.actualSize,
				durationClass,
				scoreLines,
			})
		}

		try {
			await deps.sendChannel(message, true)
		} catch (mdErr) {
			// Unescaped Markdown (e.g. `_` in a symbol) makes Telegram reject the
			// message. Retry as plain text rather than lose the alert.
			console.warn('[TelegramWorker] Markdown send failed, retrying as plain text:', mdErr)
			try {
				await deps.sendChannel(message.replace(/[*_`]/g, ''), false)
			} catch (plainErr) {
				await releaseAlertSlot(alertStore, slotArgs).catch(() => {})
				note(obs, (o) => {
					o.suppressed = 'SEND_FAILED'
				})
				throw plainErr
			}
		}
		note(obs, (o) => {
			o.alertSent = true
		})

		console.log(
			`✅ [${data.side}] Alert dispatched for ${data.symbol}${decision ? ` (score ${decision.score}/100)` : ''}`,
		)
	} catch (error) {
		console.error(`❌ Failed to send Telegram alert:`, error)
		note(obs, (o) => {
			if (!o.suppressed && !o.alertSent) o.suppressed = 'WORKER_ERROR'
		})
	}
}

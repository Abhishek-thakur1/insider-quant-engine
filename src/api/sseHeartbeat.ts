// ============================================================
// src/api/sseHeartbeat.ts — keep-alive for the /api/events stream
// ============================================================
// The Vercel /api rewrite closed /api/events after 151 s on both production domains (measured
// 2026-10-23 10:16 IST, no position open, so the stream carried no data). An SSE comment line
// (": ...") is ignored by EventSource, so no client change is needed. If the cut turns out to be
// a hard cap rather than an idle timeout, this does not help: scripts/sse_soak.sh tells which.

export const SSE_HEARTBEAT_MS = 25_000

/** Writes an SSE comment every `intervalMs`. Returns the stop function (call it on close). */
export function startSseHeartbeat(write: (chunk: string) => unknown, intervalMs = SSE_HEARTBEAT_MS, now: () => number = Date.now): () => void {
	const timer = setInterval(() => {
		try {
			write(`: ping ${now()}\n\n`)
		} catch {
			/* socket already gone; the close handler stops the timer */
		}
	}, intervalMs)
	return () => clearInterval(timer)
}

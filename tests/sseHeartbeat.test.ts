// ============================================================
// tests/sseHeartbeat.test.ts — /api/events keep-alive (src/api/sseHeartbeat.ts)
// ============================================================
// The Vercel /api rewrite closed an idle stream at 151 s. These tests emulate that with a local
// proxy that cuts a connection idle for IDLE_MS, scaled down so the suite stays fast. The real
// check through the production /api route is scripts/sse_soak.sh, run after the API deploy.

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { SSE_HEARTBEAT_MS, startSseHeartbeat } from '../src/api/sseHeartbeat.js'

const IDLE_MS = 300
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)))

/** origin SSE server -> idle-timeout proxy -> client; how long the client's stream stayed open. */
async function streamThroughIdleProxy(heartbeatMs: number, runMs: number) {
	const origin = http.createServer((req, res) => {
		res.writeHead(200, { 'Content-Type': 'text/event-stream' })
		res.write('retry: 3000\n\n')
		const stop = startSseHeartbeat((c) => res.write(c), heartbeatMs)
		req.on('close', stop)
	})
	const originPort = await listen(origin)
	const proxy = http.createServer((req, pres) => {
		let timer: NodeJS.Timeout | undefined
		const up = http.request({ host: '127.0.0.1', port: originPort, path: req.url }, (ures) => {
			pres.writeHead(ures.statusCode ?? 502, ures.headers)
			ures.on('data', arm)
			ures.pipe(pres)
		})
		function arm() {
			clearTimeout(timer)
			timer = setTimeout(() => { up.destroy(); pres.destroy() }, IDLE_MS)
		}
		arm()
		pres.on('close', () => { clearTimeout(timer); up.destroy() })
		up.on('error', () => {})
		up.end()
	})
	const proxyPort = await listen(proxy)

	const t0 = Date.now()
	let body = ''
	let endedAt: number | null = null
	const req = http.get({ host: '127.0.0.1', port: proxyPort, path: '/api/events' }, (res) => {
		res.setEncoding('utf8')
		res.on('data', (c: string) => { body += c })
		res.on('close', () => { endedAt ??= Date.now() - t0 })
	})
	req.on('error', () => { endedAt ??= Date.now() - t0 })
	await sleep(runMs)
	const survived = endedAt === null
	req.destroy()
	proxy.closeAllConnections(); origin.closeAllConnections()
	await new Promise((r) => proxy.close(r)); await new Promise((r) => origin.close(r))
	return { survived, endedAt, pings: (body.match(/^: ping \d+$/gm) ?? []).length }
}

test('SSE HEARTBEAT: writes an SSE comment each interval and stops when told', (t) => {
	// mock timers: deterministic under a loaded full-suite run (the real-sleep version flaked)
	t.mock.timers.enable({ apis: ['setInterval'] })
	const chunks: string[] = []
	const stop = startSseHeartbeat((c) => { chunks.push(c) }, 20, () => 42)
	t.mock.timers.tick(110)
	stop()
	assert.equal(chunks.length, 5, 'one ping per 20 ms interval')
	for (const c of chunks) assert.equal(c, ': ping 42\n\n', 'a comment line: EventSource ignores it, no client change')
	t.mock.timers.tick(100)
	assert.equal(chunks.length, 5, 'no writes after stop')
})

test('SSE HEARTBEAT: a write that throws (dead socket) does not escape the timer', (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] })
	let calls = 0
	const stop = startSseHeartbeat(() => { calls++; throw new Error('write after end') }, 15)
	t.mock.timers.tick(60) // would throw out of tick() if the error escaped the interval callback
	stop()
	assert.equal(calls, 4)
})

test('SSE HEARTBEAT: production interval is well inside the 151 s cut', () => {
	assert.ok(SSE_HEARTBEAT_MS <= 30_000 && SSE_HEARTBEAT_MS * 5 < 151_000)
})

test('SSE THROUGH IDLE PROXY: without a heartbeat the idle stream is cut (reproduces the 151 s cut, scaled)', async () => {
	const r = await streamThroughIdleProxy(60_000, IDLE_MS * 4)
	assert.equal(r.survived, false)
	assert.ok(r.endedAt !== null && r.endedAt >= IDLE_MS - 50 && r.endedAt < IDLE_MS * 2, `cut at ~${IDLE_MS} ms, got ${r.endedAt}`)
})

test('SSE THROUGH IDLE PROXY: with the heartbeat the stream survives 4x the idle cut', async () => {
	const r = await streamThroughIdleProxy(IDLE_MS / 5, IDLE_MS * 4)
	assert.equal(r.survived, true, `stream ended at ${r.endedAt} ms`)
	assert.ok(r.pings >= 10, `pings received through the proxy: ${r.pings}`)
})

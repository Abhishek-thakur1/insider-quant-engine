// ============================================================
// tests/composeExposure.test.ts — what docker-compose.yml publishes on the host (audit of 31 Oct)
//
// Every container reaches Redis and Postgres by service name on the compose network (REDIS_HOST is
// the service name; the host monitor uses `docker exec quant_redis redis-cli`). Nothing needs the
// Redis port on a public interface, and Redis runs without a password, so it is bound to loopback.
// Postgres is never published.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const compose = fs.readFileSync('docker-compose.yml', 'utf8').replace(/\r\n/g, '\n')
const live = compose.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
const service = (name: string) => {
	const start = live.indexOf(`\n  ${name}:\n`)
	assert.ok(start >= 0, `service ${name} not found`)
	const next = live.slice(start + 1).search(/\n {2}[a-z_]+:\n|\nvolumes:\n/)
	return live.slice(start, start + 1 + next)
}
const ports = (body: string) => [...body.matchAll(/^\s+- ['"]?([^'"\n]+)['"]?$/gm)].map((m) => m[1]!).filter((p) => /^[\d.:[\]]+$/.test(p))

test('REDIS: published on loopback only, never on all interfaces', () => {
	const p = ports(service('redis_cache'))
	assert.ok(p.length > 0, 'redis keeps a loopback port for host-side tools')
	for (const x of p) assert.match(x, /^127\.0\.0\.1:\d+:\d+$/, `redis port mapping ${x} must start with 127.0.0.1`)
})

test('POSTGRES: not published at all', () => {
	assert.doesNotMatch(service('postgres_db'), /\n\s+ports:/)
})

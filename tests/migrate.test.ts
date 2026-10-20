// ============================================================
// tests/migrate.test.ts — versioned migration runner
//
// Exercises the real src/db/migrate.ts against a fake query client that keeps
// schema_migrations in memory. No Postgres needed. Also checks the shipped
// db/migrations files themselves: they must parse, and the data migration must
// never rewrite outcome columns.
// ============================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
	checksumOf,
	computePending,
	migrate,
	parseMigrations,
	readMigrationFiles,
	schemaProblem,
	verifyApplied,
	MIGRATIONS_DIR,
	type MigrateClient,
} from '../src/db/migrate.js'

const makeDir = (files: Record<string, string>): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-migrations-'))
	for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql)
	return dir
}

// Fake pg client: tracks schema_migrations rows and records every statement.
const makeClient = (
	opts: {
		tableExists?: boolean
		applied?: { version: string; name: string; checksum: string }[]
		failOn?: string
	} = {},
) => {
	let tableExists = opts.tableExists ?? false
	const rows = [...(opts.applied ?? [])]
	const log: string[] = []
	const client: MigrateClient & { log: string[]; rows: typeof rows } = {
		log,
		rows,
		release: () => {},
		query: async (sql: string, params?: unknown[]) => {
			const s = sql.trim()
			log.push(s)
			if (opts.failOn && s.includes(opts.failOn)) throw new Error('boom')
			if (s.startsWith('SELECT to_regclass'))
				return { rows: [{ t: tableExists ? 'schema_migrations' : null }] }
			if (s.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
				tableExists = true
				return { rows: [] }
			}
			if (s.startsWith('SELECT version, name, checksum')) return { rows: [...rows] }
			if (s.startsWith('INSERT INTO schema_migrations')) {
				const [version, name, checksum] = params as string[]
				rows.push({ version: version!, name: name!, checksum: checksum! })
			}
			return { rows: [] }
		},
	}
	return client
}

const quiet = () => {}

test('parseMigrations orders by version and rejects bad names / duplicates', () => {
	const parsed = parseMigrations([
		{ filename: '0002_b.sql', sql: 'B' },
		{ filename: '0001_a.sql', sql: 'A' },
	])
	assert.deepEqual(
		parsed.map((m) => m.version),
		['0001', '0002'],
	)
	assert.throws(() => parseMigrations([{ filename: '1_a.sql', sql: '' }]), /Bad migration filename/)
	assert.throws(
		() =>
			parseMigrations([
				{ filename: '0001_a.sql', sql: '' },
				{ filename: '0001_b.sql', sql: '' },
			]),
		/Duplicate migration version/,
	)
})

test('checksum ignores CRLF vs LF', () => {
	assert.equal(checksumOf('a\r\nb\r\n'), checksumOf('a\nb\n'))
	assert.notEqual(checksumOf('a\nb'), checksumOf('a\nc'))
})

test('verifyApplied rejects an edited or deleted applied migration', () => {
	const files = parseMigrations([{ filename: '0001_a.sql', sql: 'A' }])
	assert.doesNotThrow(() =>
		verifyApplied(files, [{ version: '0001', name: 'a', checksum: checksumOf('A') }]),
	)
	assert.throws(
		() => verifyApplied(files, [{ version: '0001', name: 'a', checksum: checksumOf('edited') }]),
		/Checksum mismatch/,
	)
	assert.throws(
		() => verifyApplied(files, [{ version: '0009', name: 'gone', checksum: 'x' }]),
		/missing/,
	)
})

test('computePending returns only unapplied versions, in order', () => {
	const files = parseMigrations([
		{ filename: '0001_a.sql', sql: 'A' },
		{ filename: '0002_b.sql', sql: 'B' },
		{ filename: '0003_c.sql', sql: 'C' },
	])
	const pending = computePending(files, [{ version: '0001', name: 'a', checksum: checksumOf('A') }])
	assert.deepEqual(
		pending.map((p) => p.version),
		['0002', '0003'],
	)
})

test('migrate applies each pending file once, in its own transaction, under an advisory lock', async () => {
	const dir = makeDir({ '0001_a.sql': 'SELECT 1 AS a', '0002_b.sql': 'SELECT 2 AS b' })
	const client = makeClient()

	assert.deepEqual(await migrate(client, { dir, log: quiet }), ['0001', '0002'])
	assert.deepEqual(
		client.rows.map((r) => r.version),
		['0001', '0002'],
	)
	assert.match(client.log[0]!, /pg_advisory_lock/)
	assert.match(client.log[client.log.length - 1]!, /pg_advisory_unlock/)
	const i = client.log.indexOf('SELECT 1 AS a')
	assert.equal(client.log[i - 1], 'BEGIN')
	assert.match(client.log[i + 1]!, /INSERT INTO schema_migrations/)
	assert.equal(client.log[i + 2], 'COMMIT')

	// Second run: nothing to do, nothing re-executed.
	const before = client.log.length
	assert.deepEqual(await migrate(client, { dir, log: quiet }), [])
	assert.ok(!client.log.slice(before).includes('SELECT 1 AS a'))
})

test('a failing migration rolls back, is not recorded, and stops the run', async () => {
	const dir = makeDir({
		'0001_ok.sql': 'SELECT 1',
		'0002_bad.sql': 'SELECT bad',
		'0003_after.sql': 'SELECT 3',
	})
	const client = makeClient({ failOn: 'SELECT bad' })

	await assert.rejects(migrate(client, { dir, log: quiet }), /0002_bad failed and was rolled back/)
	assert.deepEqual(
		client.rows.map((r) => r.version),
		['0001'],
	)
	assert.ok(client.log.includes('ROLLBACK'))
	assert.ok(!client.log.includes('SELECT 3'))
	assert.match(client.log[client.log.length - 1]!, /pg_advisory_unlock/)
})

test('dry run lists pending files and executes nothing', async () => {
	const dir = makeDir({ '0001_a.sql': 'SELECT 1 AS a' })
	const client = makeClient()
	const lines: string[] = []

	assert.deepEqual(await migrate(client, { dir, dryRun: true, log: (m) => lines.push(m) }), [
		'0001',
	])
	assert.ok(lines.some((l) => l.includes('0001_a')))
	assert.ok(
		!client.log.some((s) => s.startsWith('CREATE TABLE') || s === 'SELECT 1 AS a' || s === 'BEGIN'),
	)
})

test('schemaProblem is read-only and reports missing table, pending, and current', async () => {
	const dir = makeDir({ '0001_a.sql': 'A' })

	const fresh = makeClient()
	assert.match((await schemaProblem(fresh, dir))!, /schema_migrations table missing/)
	assert.ok(fresh.log.every((s) => s.startsWith('SELECT')))

	assert.match(
		(await schemaProblem(makeClient({ tableExists: true }), dir))!,
		/1 pending migration\(s\): 0001_a/,
	)

	const current = makeClient({
		tableExists: true,
		applied: [{ version: '0001', name: 'a', checksum: checksumOf('A') }],
	})
	assert.equal(await schemaProblem(current, dir), null)

	const edited = makeClient({
		tableExists: true,
		applied: [{ version: '0001', name: 'a', checksum: 'stale' }],
	})
	assert.match((await schemaProblem(edited, dir))!, /Checksum mismatch/)
})

test('shipped migrations parse and the data migration never rewrites outcome columns', () => {
	const files = readMigrationFiles(MIGRATIONS_DIR)
	assert.deepEqual(
		files.map((f) => `${f.version}_${f.name}`),
		['0001_baseline', '0002_data_quality', '0003_flag_and_resolve_ghosts', '0004_signals', '0005_screener_sources'],
	)

	// No statement in any migration may assign an outcome column.
	const outcome =
		/\b(SET|,)\s*(exit_price|exit_time|realized_pnl|r_multiple|qty|actual_size|duration_class)\s*=/i
	for (const f of files) {
		const code = f.sql.replace(/--.*$/gm, '')
		assert.ok(!outcome.test(code), `${f.version}_${f.name} assigns an outcome column`)
	}
})

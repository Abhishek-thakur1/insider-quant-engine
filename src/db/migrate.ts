// ============================================================
// src/db/migrate.ts — versioned, one-time Postgres migrations
//
// Replaces the boot-time block that used to live in src/api/server.ts and
// rewrote historical rows on every quant_api start.
//
// Rules:
//   - Migrations are plain SQL files in db/migrations/, named NNNN_name.sql,
//     applied in filename order, each exactly once.
//   - Each file runs in its own transaction together with its schema_migrations
//     row, so a failure leaves nothing half-applied.
//   - An applied file whose contents changed is a hard error. Write a new
//     migration instead of editing an old one.
//   - Nothing runs automatically. The owner runs `npm run migrate` explicitly
//     (`-- --dry-run` lists pending files without applying them).
// ============================================================

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'db', 'migrations')

// Arbitrary constant key for pg_advisory_lock: stops two containers migrating at once
const ADVISORY_LOCK_KEY = 728_415_001

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/

export interface MigrationFile {
	version: string
	name: string
	sql: string
	checksum: string
}

export interface AppliedMigration {
	version: string
	name: string
	checksum: string
}

/** Minimal query surface so the pure logic can be tested without Postgres. */
export interface Queryable {
	query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

/** CRLF-normalised so a Windows checkout doesn't look like an edited migration. */
export const checksumOf = (sql: string): string =>
	crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex')

/** Parse and order migration files. Rejects bad names and duplicate versions. */
export const parseMigrations = (files: { filename: string; sql: string }[]): MigrationFile[] => {
	const out: MigrationFile[] = []
	const seen = new Set<string>()
	for (const { filename, sql } of files) {
		const m = FILE_RE.exec(filename)
		if (!m) throw new Error(`Bad migration filename "${filename}" (expected NNNN_name.sql)`)
		const version = m[1]!
		if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`)
		seen.add(version)
		out.push({ version, name: m[2]!, sql, checksum: checksumOf(sql) })
	}
	return out.sort((a, b) => a.version.localeCompare(b.version))
}

export const readMigrationFiles = (dir: string = MIGRATIONS_DIR): MigrationFile[] =>
	parseMigrations(
		fs
			.readdirSync(dir)
			.filter((f) => f.endsWith('.sql'))
			.map((filename) => ({ filename, sql: fs.readFileSync(path.join(dir, filename), 'utf8') })),
	)

/** Throws if an applied migration was edited or deleted from disk. */
export const verifyApplied = (files: MigrationFile[], applied: AppliedMigration[]): void => {
	const byVersion = new Map(files.map((f) => [f.version, f]))
	for (const a of applied) {
		const f = byVersion.get(a.version)
		if (!f)
			throw new Error(`Applied migration ${a.version}_${a.name} is missing from ${MIGRATIONS_DIR}`)
		if (f.checksum !== a.checksum) {
			throw new Error(
				`Checksum mismatch for applied migration ${a.version}_${a.name}. ` +
					'Applied migrations must never be edited — add a new migration instead.',
			)
		}
	}
}

export const computePending = (
	files: MigrationFile[],
	applied: AppliedMigration[],
): MigrationFile[] => {
	const done = new Set(applied.map((a) => a.version))
	return files.filter((f) => !done.has(f.version))
}

const CREATE_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS schema_migrations (
		version    TEXT PRIMARY KEY,
		name       TEXT NOT NULL,
		checksum   TEXT NOT NULL,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`

/** Applied migrations, or null if schema_migrations doesn't exist yet. Read-only. */
export const readApplied = async (db: Queryable): Promise<AppliedMigration[] | null> => {
	const exists = await db.query(`SELECT to_regclass('public.schema_migrations') AS t`)
	if (!exists.rows[0]?.t) return null
	const res = await db.query(
		`SELECT version, name, checksum FROM schema_migrations ORDER BY version`,
	)
	return res.rows as unknown as AppliedMigration[]
}

/**
 * Read-only status check for service boot. Never mutates, never throws.
 * Returns a human-readable problem, or null when the schema is current.
 */
export const schemaProblem = async (
	db: Queryable,
	dir: string = MIGRATIONS_DIR,
): Promise<string | null> => {
	try {
		const files = readMigrationFiles(dir)
		const applied = await readApplied(db)
		if (applied === null) return 'schema_migrations table missing — run `npm run migrate`'
		verifyApplied(files, applied)
		const pending = computePending(files, applied)
		if (pending.length > 0) {
			return `${pending.length} pending migration(s): ${pending.map((p) => `${p.version}_${p.name}`).join(', ')}`
		}
		return null
	} catch (err) {
		return `schema check failed: ${(err as Error).message}`
	}
}

export interface MigrateClient extends Queryable {
	release: () => void
}

/** Apply all pending migrations. Returns the versions applied (or that would be, on dry run). */
export const migrate = async (
	client: MigrateClient,
	opts: { dryRun?: boolean; dir?: string; log?: (msg: string) => void } = {},
): Promise<string[]> => {
	const log = opts.log ?? console.log
	const files = readMigrationFiles(opts.dir)

	if (opts.dryRun) {
		const applied = (await readApplied(client)) ?? []
		verifyApplied(files, applied)
		const pending = computePending(files, applied)
		log(
			pending.length
				? `[migrate] Pending (dry run, nothing applied):`
				: '[migrate] Nothing pending.',
		)
		for (const p of pending) log(`  ${p.version}_${p.name}`)
		return pending.map((p) => p.version)
	}

	await client.query(`SELECT pg_advisory_lock($1)`, [ADVISORY_LOCK_KEY])
	try {
		await client.query(CREATE_TABLE_SQL)
		const applied = (await readApplied(client)) ?? []
		verifyApplied(files, applied)
		const pending = computePending(files, applied)
		if (pending.length === 0) log('[migrate] Nothing pending.')

		const done: string[] = []
		for (const m of pending) {
			log(`[migrate] Applying ${m.version}_${m.name} ...`)
			await client.query('BEGIN')
			try {
				await client.query(m.sql)
				await client.query(
					`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
					[m.version, m.name, m.checksum],
				)
				await client.query('COMMIT')
			} catch (err) {
				await client.query('ROLLBACK')
				throw new Error(
					`Migration ${m.version}_${m.name} failed and was rolled back: ${(err as Error).message}`,
				)
			}
			done.push(m.version)
			log(`[migrate] ✅ ${m.version}_${m.name}`)
		}
		return done
	} finally {
		await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_KEY]).catch(() => {})
	}
}

// ── CLI: npm run migrate [-- --dry-run] ─────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
	const { pool } = await import('../config/db.js')
	let code = 0
	try {
		const client = await pool.connect()
		try {
			await migrate(client, { dryRun: process.argv.includes('--dry-run') })
		} finally {
			client.release()
		}
	} catch (err) {
		console.error('[migrate] ❌', (err as Error).message)
		code = 1
	} finally {
		await pool.end()
	}
	process.exit(code)
}

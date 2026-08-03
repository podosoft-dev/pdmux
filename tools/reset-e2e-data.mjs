#!/usr/bin/env node
/**
 * reset-e2e-data — put the development database back to the state the e2e suite
 * expects to start from.
 *
 * WHY: the suite creates accounts, hosts, tokens and sessions, and not every
 * spec can clean up after itself (a spec that verifies a *ban* cannot then log
 * in to delete the account). Run the suite a few times and the user list holds
 * hundreds of rows — at which point the specs that assert on searching and
 * paginating that list start failing for reasons that have nothing to do with
 * the product. Measured here: 591 users after a dozen runs, and a moving set of
 * failures that looked like flakiness.
 *
 * This deletes test-created rows only. The two seeded accounts stay, because the
 * setup project's storageState refers to them. It talks to Postgres directly on
 * purpose: the API has no bulk-delete, and it should not grow one for a test.
 *
 * Usage (repo root, with .env loaded):
 *   node tools/reset-e2e-data.mjs [--dry-run]
 */
import { spawnSync } from 'node:child_process';

const dryRun = process.argv.includes('--dry-run');

const PG = {
	host: process.env.POSTGRES_HOST ?? 'localhost',
	port: process.env.POSTGRES_PORT ?? '5440',
	user: process.env.POSTGRES_USER ?? 'pdmux',
	password: process.env.POSTGRES_PASSWORD ?? 'pdmux',
	db: process.env.POSTGRES_DB ?? 'pdmux',
};

/** Accounts the seeded sessions belong to — everything else is disposable. */
const KEEP_EMAILS = ['admin@example.com', 'user@example.com'];

const keepList = KEEP_EMAILS.map((email) => `'${email}'`).join(', ');

// Children first: better-auth's tables reference `user`, and not every foreign
// key cascades. Hosts cascade to their own children, so one delete is enough
// there.
const STATEMENTS = [
	`DELETE FROM session WHERE "userId" IN (SELECT id FROM "user" WHERE email NOT IN (${keepList}))`,
	`DELETE FROM account WHERE "userId" IN (SELECT id FROM "user" WHERE email NOT IN (${keepList}))`,
	`DELETE FROM member WHERE "userId" IN (SELECT id FROM "user" WHERE email NOT IN (${keepList}))`,
	`DELETE FROM "twoFactor" WHERE "userId" IN (SELECT id FROM "user" WHERE email NOT IN (${keepList}))`,
	`DELETE FROM passkey WHERE "userId" IN (SELECT id FROM "user" WHERE email NOT IN (${keepList}))`,
	`DELETE FROM apikey WHERE "userId" IN (SELECT id FROM "user" WHERE email NOT IN (${keepList}))`,
	`DELETE FROM invitation WHERE "inviterId" IN (SELECT id FROM "user" WHERE email NOT IN (${keepList}))`,
	`DELETE FROM "user" WHERE email NOT IN (${keepList})`,
	`DELETE FROM hosts WHERE label LIKE 'e2e-%' OR label LIKE 'pdmux-e2e%'`,
	`DELETE FROM audit_logs WHERE "createdAt" < now() - interval '1 hour'`,
];

function psql(sql) {
	const result = spawnSync(
		'docker',
		['exec', '-e', `PGPASSWORD=${PG.password}`, 'pdmux-postgres-1', 'psql', '-U', PG.user, '-d', PG.db, '-tAc', sql],
		{ encoding: 'utf8' },
	);
	if (result.status !== 0) {
		// A missing table is fine: modules are optional and this script must not
		// depend on which ones happen to be installed.
		const stderr = result.stderr ?? '';
		if (/does not exist/i.test(stderr)) return null;
		throw new Error(`psql failed: ${stderr.trim() || result.stdout}`);
	}
	return (result.stdout ?? '').trim();
}

const before = psql(`SELECT count(*) FROM "user"`);
console.log(`${before} user(s) · keeping ${KEEP_EMAILS.join(', ')}`);

if (dryRun) {
	for (const sql of STATEMENTS) console.log(`  would run: ${sql.slice(0, 100)}…`);
	process.exit(0);
}

for (const sql of STATEMENTS) psql(sql);

const after = psql(`SELECT count(*) FROM "user"`);
const hosts = psql(`SELECT count(*) FROM hosts`);
console.log(`done — users ${before} → ${after}, hosts ${hosts}`);

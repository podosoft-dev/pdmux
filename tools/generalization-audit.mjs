#!/usr/bin/env node
/**
 * generalization-audit — fail the build if anything from the private tool this
 * product was generalised from leaked into the source.
 *
 * WHY: pdmux started life as an internal dashboard wired to one company's hosts,
 * domains and vendor names. Generalising it is not just a rename — a single
 * leftover hostname in a default, a fixture or a doc turns a public repository
 * into an information disclosure, and it is exactly the kind of thing that
 * survives a careful port because nobody greps for it afterwards.
 *
 * Deliberately conservative: it scans **tracked files only** (no node_modules, no
 * build output), matches whole words, and keeps an explicit allowlist for terms
 * that also have an innocent meaning, so a real hit is always worth reading.
 *
 * THE TERMS ARE STORED AS DIGESTS, NOT AS TEXT. A list of the names to keep out is
 * itself a list of the names — spelled out in the repository, indexed by every code
 * search, and copied into every fork. So each term is kept as a salted SHA-256 prefix
 * and the scanner hashes candidate words to compare. The `what` note carries the
 * meaning a reader needs when a hit is reported; the report prints the term it found
 * in the scanned file, which is the only place the plaintext exists.
 *
 * This hides the names from a reader and from a grep. It is NOT a secret: the salt is
 * right here, so anyone who already suspects a term can confirm it by hashing a guess.
 * That is the intended strength — never treat a digest here as a place to hide a
 * credential.
 *
 * Usage:
 *   node tools/generalization-audit.mjs           # human report, exit 1 on a hit
 *   node tools/generalization-audit.mjs --json
 *   node tools/generalization-audit.mjs --digest <term>   # value to paste below
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const asJson = process.argv.includes('--json');

const SALT = 'pdmux-generalization-audit-v1';
const digestCache = new Map();

/** Salted digest of an already-lowercased term. Cached: a lockfile repeats words a lot. */
function digest(term) {
	let value = digestCache.get(term);
	if (value === undefined) {
		value = createHash('sha256').update(`${SALT}:${term}`).digest('hex').slice(0, 16);
		digestCache.set(term, value);
	}
	return value;
}

const digestFlag = process.argv.indexOf('--digest');
if (digestFlag !== -1 && process.argv[digestFlag + 1]) {
	console.log(digest(process.argv[digestFlag + 1].toLowerCase()));
	process.exit(0);
}

/**
 * Terms that must never appear, as digests. Each entry says what it was, so a future
 * reader can tell a real leak from a coincidence without hunting for context.
 *
 * `exact` matches a whole word, where a hyphen counts as a word break — so a digest of
 * `a-b` is found inside `a-b-c`, exactly as the `\ba-b\b` patterns this replaced were.
 * `prefix` matches a word that STARTS with the hidden term and carries its length,
 * which is how the `foo\w*` / `foo\d*` / `food?` patterns are expressed.
 */
const FORBIDDEN = [
	{ digest: '476fded079d3bb98', mode: 'exact', what: 'the internal name of the tool this generalises' },
	{ digest: '7f58393d93ac2f36', mode: 'exact', what: 'the private monorepo' },
	{ digest: 'f57fd761aca948cf', mode: 'exact', what: 'a service of the private monorepo' },
	{ digest: 'a4a5517568699d65', mode: 'exact', what: 'a service of the private monorepo' },
	{ digest: '521f2b6af709ce67', mode: 'exact', what: 'a private service name' },
	{ digest: '261fe9e12c55ecae', mode: 'exact', what: 'a private service name' },
	{ digest: '5d501f0b12472aa0', mode: 'exact', what: 'a private service name' },
	{ digest: 'c6ff3a50b25c123c', mode: 'exact', what: 'a private service name' },
	{ digest: '0f8fd56afdd2a680', mode: 'exact', what: 'a private service name' },
	{ digest: 'a746eb041d98d6a1', mode: 'exact', what: 'a private service name' },
	{ digest: 'da4c26526c4b6606', mode: 'prefix', length: 8, what: 'a specific workstation hostname' },
	{ digest: 'be5feb17787edfa5', mode: 'prefix', length: 6, what: 'a private domain' },
	{ digest: 'bfd1ee196d31851a', mode: 'exact', what: 'a private domain' },
	{ digest: '95089021ceb6e3d3', mode: 'exact', what: 'a vendor name of the original deployment' },
	{ digest: '8380812b39ad0212', mode: 'exact', what: 'a vendor name of the original deployment' },
	{ digest: '663f53f1dd8277b3', mode: 'exact', what: 'a vendor name of the original deployment' },
	{ digest: 'eab6ebe419aadecc', mode: 'exact', what: 'a private product name' },
	{ digest: '2b366f5f3dae53d0', mode: 'exact', what: 'a private product name' },
	{ digest: '838e33f363bbbcea', mode: 'exact', what: 'an unrelated account identity' },
	{ digest: '1c625f07b9da2759', mode: 'exact', what: 'the original secret store, not a dependency here' },
	{
		digest: '6180b699adf1ec6b',
		mode: 'prefix',
		length: 10,
		what: 'the original access gateway; pdmux must not require it',
	},
	{ digest: '70d784102340baee', mode: 'exact', what: 'the terminal server pdmux replaced with its own PTY' },
];

/**
 * Whole words that a given file may legitimately contain, as digests. Permission is
 * per word rather than per line, so allowing a compound (`a-b-c`) does not also allow
 * the bare term (`a-b`) hiding inside it — which is the point of several entries
 * below. Adding one stays a conscious act.
 */
const ALLOW = [
	// The architecture record explains what changed and why; naming the thing it
	// replaced is the point of that document. Same for the operations guide, which
	// names the gateway an operator may put in front. These live in the WORKSPACE now,
	// reached with `--extra-root`; the paths stay relative to whichever root the file
	// came from, so they read the same as before.
	{ file: 'docs/ARCHITECTURE.md', words: ['70d784102340baee', '6180b699adf1ec6b', '07e25fc255c61660'] },
	{ file: 'docs/OPERATIONS.md', words: ['6180b699adf1ec6b', '07e25fc255c61660'] },
	// Transitive dependency names the lockfile records. We do not depend on the
	// service; npm writes the package name, and the versioned tarball URL repeats it.
	{ file: 'package-lock.json', words: ['6180b699adf1ec6b', 'c253221a80dc86ec'] },
	// PodoKit ships this OAuth guide; it names tunnels as one way to get an https
	// callback in development. It is a suggestion in a vendored doc, not a
	// requirement of pdmux.
	{
		file: '.claude/skills/podokit-configure-auth/references/google.md',
		words: ['6180b699adf1ec6b', '07e25fc255c61660'],
	},
	/*
	 * The usage snapshot's LEGACY FILENAME, which is functional rather than descriptive.
	 *
	 * This is not pdmux naming the tool it generalises — it is pdmux reading a file that
	 * tool's wrapper still writes. The snapshot is produced by a statusline wrapper the
	 * operator installed once, and that wrapper outlives the deployment that asked for it:
	 * measured here, one was writing a perfectly good snapshot every few seconds under the
	 * old name while the agent read the new one and the card said "no budget reported".
	 * Generalising the string would break the compatibility it exists for. The tests and
	 * the docs quote the same name because a filename you cannot write down is not a
	 * filename an operator can check.
	 *
	 * Only the compound filename is permitted here; the bare term inside it is not.
	 */
	{ file: 'agent/internal/usage/registry.go', words: ['cf684d818712cbe1'] },
	{ file: 'agent/internal/usage/registry_test.go', words: ['cf684d818712cbe1'] },
	{ file: 'agent/internal/usage/snapshot.go', words: ['cf684d818712cbe1'] },
	{ file: 'docs/CONTRACTS.md', words: ['cf684d818712cbe1'] },
	{ file: 'docs/testing/traceability/pdagent.md', words: ['cf684d818712cbe1'] },
];

/**
 * Shapes, not names — the second half of this audit.
 *
 * ⚠ WHY THESE CANNOT BE DIGESTS. `WORD` below has no dot in it, so `reg.example.io`
 * tokenises as three separate words and a digest of the whole hostname would never be
 * compared against anything. The same is true of an IP address and of an absolute path.
 * The digest list catches proper nouns; this list catches the shapes that are wrong
 * regardless of what they are called.
 *
 * ⚠ AND THIS IS WHERE THE PUBLIC/PRIVATE SPLIT IS ENFORCED. pdmux is a public
 * repository whose operating deployment is not. A private address, an SSH endpoint
 * fingerprint or a host's env-file layout is not a credential, but together they are a
 * map of somebody's internal network — and once published, published.
 *
 * `id` is what a per-file exemption names, so it has to stay stable.
 */
const PATTERNS = [
	{
		id: 'deployment-host',
		// The bare domain is public (it is the npm scope and the GitHub org). What must
		// not be here is a SUBDOMAIN, which names a machine or a service of ours.
		re: /\b[a-z0-9][a-z0-9-]*\.podosoft\.io\b/i,
		what: 'a host of this deployment, not of the product',
	},
	{
		id: 'home-subnet',
		// ⚠ NARROW ON PURPOSE — 192.168 ONLY. See the note below: banning every RFC1918
		// range produced 100+ hits on fixtures and comments that leak nothing. This one
		// range appears exactly once in the whole repository, in the spec that exists to
		// assert what a private address means, so the rule costs one exemption and
		// catches the shape the deployment profile actually carried.
		re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
		what: 'a private address on a real network — where something of ours actually sits',
	},
	// ⚠ NO BLANKET RFC1918 RULE, ON PURPOSE. Private addresses are legitimate example
	// data throughout the specs and the docs — `10.0.0.7` in a fixture, `172.22.0.2` in
	// a comment explaining container bridges. Banning the shape produced 100+ hits on
	// files that leak nothing, and an audit that cries wolf is one people stop reading.
	// What actually carries our addresses is the deployment profile, and the two rules
	// below catch that file itself if it is ever committed.
	{
		id: 'endpoint-fingerprint',
		re: /endpointFingerprint/,
		what: "an SSH endpoint fingerprint — identifies one machine we deploy to",
	},
	{
		id: 'host-env-path',
		re: /\/etc\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]*\.env\b/,
		what: 'where secrets are laid out on a deployment host',
	},
	{
		id: 'korean',
		// ⚠ THE PUBLIC REPOSITORY IS ENGLISH. Not a style preference: architecture and
		// contract documents nobody can read are documents nobody can contribute against.
		// Korean that is DATA rather than prose is exempt per file below.
		//
		// ⚠ `rootOnly` — THIS ONE DOES NOT CROSS INTO AN EXTRA ROOT. The rule is about
		// the repository that ships to strangers; the workspace that operates a
		// deployment is private and its documents are Korean on purpose. Applied there
		// it fires on every line of the traceability matrices, which is not a finding.
		rootOnly: true,
		re: /[\uAC00-\uD7A3]/,
		what: 'Korean prose — the public repository is written in English',
	},
];

/**
 * Files exempt from a shape, by pattern id, with the reason.
 *
 * Kept separate from `ALLOW` because that one is keyed by word digest and these rules
 * have no word to key on. Adding an entry stays a conscious act either way.
 */
const PATTERN_ALLOW = [
	// The rule under test IS "a private address means something specific". Removing the
	// fixture removes what the spec measures.
	{ file: 'apps/web/test/map.test.ts', ids: ['home-subnet'] },
	// The Korean README, which is the point of it — and the English one, whose link to
	// it is labelled in Korean so a Korean reader can find it without reading English
	// first. That is the ordinary convention for a translated README.
	{ file: 'README-ko.md', ids: ['korean'] },
	{ file: 'README.md', ids: ['korean'] },
	// Translation catalogues and the specs that assert a translated string.
	{ file: 'apps/web/src/lib/i18n/locales/ko.json', ids: ['korean'] },
	{ file: 'apps/web/src/lib/i18n/catalogs/app/ko.json', ids: ['korean'] },
	{ file: 'apps/web/src/lib/i18n/catalogs/admin-dashboard/ko.json', ids: ['korean'] },
	{ file: 'apps/web/test/i18n-placeholders.test.ts', ids: ['korean'] },
	{ file: 'apps/web/test/layout-store.test.ts', ids: ['korean'] },
	// ⚠ Korean as a MULTI-BYTE FIXTURE. These specs cut a UTF-8 sequence at a byte
	// boundary and check the halves; replacing the text deletes what they measure.
	{ file: 'agent/internal/term/pty_test.go', ids: ['korean'] },
	{ file: 'agent/internal/term/manager_test.go', ids: ['korean'] },
	// ⚠ THE EVIDENCE ITSELF. This document's whole argument is a log of what a real
	// device sent while somebody typed Korean; paraphrasing it in English would delete
	// the measurement and leave an assertion.
	{ file: 'docs/IME_INPUT.md', ids: ['korean'] },
	// Playwright specs match the screen in whichever locale it is showing, so the
	// Korean here is the app's own translated strings — the thing under assertion.
	{ file: 'tests/ui/account.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/auth.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/dashboard.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/i18n.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/organizations.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/users.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/pdmux-fleet-settings.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/pdmux-hosts.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/pdmux-terminal.ui.spec.ts', ids: ['korean'] },
	{ file: 'tests/ui/pdmux-mobile-terminal.mobile.spec.ts', ids: ['korean'] },
	// This file spells out the shapes it forbids, which is the only place they exist.
	{ file: 'tools/generalization-audit.mjs', ids: PATTERNS.map((p) => p.id) },
];

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.zip']);

/**
 * Extra checkouts to scan alongside this one.
 *
 * The prose that documents this product lives in the workspace that owns this
 * repository, not in the repository — so scanning only `ROOT` would leave exactly the
 * files most likely to name the original tool (an architecture record, an operations
 * guide, an investigation) unchecked. `--extra-root ..` from the workspace covers them
 * with the same rules and the same allowlist, rather than a second copy of this file
 * that would drift.
 */
const extraRoots = process.argv.reduce((acc, arg, i) => {
	if (arg === '--extra-root' && process.argv[i + 1]) acc.push(resolve(process.argv[i + 1]));
	return acc;
}, []);

/**
 * Paths in an extra root that are EXEMPT, because naming things is their job.
 *
 * The rule this file enforces exists because the product is generalised: a hostname
 * in `apps/`, a fixture or a product document is an information disclosure. The
 * workspace that operates a deployment is the opposite — its rules and investigation
 * records are private, and "run this on the workstation" is useless without saying
 * which workstation. So the split is structural rather than a growing list of
 * individual files: product documentation under `docs/` stays neutral and is checked;
 * operational records live under `docs/workspace/` and the workspace's own guidance,
 * and are not. Never apply this to the product repository itself.
 */
const OPERATIONAL = [
	/^\.claude\//,
	/^docs\/workspace\//,
	/^CLAUDE\.md$/,
	/^AGENTS\.md$/,
	/^check\.sh$/,
	// An operational record can also be executable. This one talks to the secret
	// store this deployment actually uses, so it names that store's helper script and
	// its functions -- the name is an API surface, not a leak. Listed as one file
	// rather than `^tools/` because the rest of that directory is the traceability
	// toolchain, which has no business naming anything.
	/^tools\/pull-deploy-env\.sh$/,
];

function trackedFiles(root, { required = true } = {}) {
	const r = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' });
	if (r.status !== 0) {
		if (!required) return [];
		console.error(`generalization-audit: not a git checkout (or git failed): ${root}`);
		process.exit(2);
	}
	// Submodules appear as a single gitlink entry; the submodule scans itself when the
	// workspace names it, so skipping directories here avoids reading a whole tree twice.
	return r.stdout.split('\n').filter(Boolean);
}

const EXACT = new Map(FORBIDDEN.filter((r) => r.mode === 'exact').map((r) => [r.digest, r.what]));
const PREFIX = FORBIDDEN.filter((r) => r.mode === 'prefix').map((r) => [r.length, r.digest, r.what]);

const ALLOW_BY_FILE = new Map();
for (const rule of ALLOW) {
	const words = ALLOW_BY_FILE.get(rule.file) ?? new Set();
	for (const word of rule.words) words.add(word);
	ALLOW_BY_FILE.set(rule.file, words);
}

const PATTERN_ALLOW_BY_FILE = new Map();
for (const rule of PATTERN_ALLOW) {
	const ids = PATTERN_ALLOW_BY_FILE.get(rule.file) ?? new Set();
	for (const id of rule.ids) ids.add(id);
	PATTERN_ALLOW_BY_FILE.set(rule.file, ids);
}

/** A word, with hyphens kept so a compound name stays one token. */
const WORD = /[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g;

/**
 * No stored term contains more than one hyphen, so only one- and two-part slices can
 * match. Raise this if a longer term is ever added, or it will silently stop matching.
 */
const MAX_TERM_PARTS = 2;

/** The hyphen-delimited slices of a word that could be a term: a-b-c -> a, a-b, b, b-c, c. */
function slices(word) {
	const parts = word.split('-');
	const out = [];
	for (let i = 0; i < parts.length; i += 1) {
		for (let n = 1; n <= MAX_TERM_PARTS && i + n <= parts.length; n += 1) {
			out.push(parts.slice(i, i + n).join('-'));
		}
	}
	return out;
}

/** Forbidden terms in one line, minus the words this file is allowed to contain. */
function findTerms(line, allowWords) {
	const found = new Map();
	for (const match of line.matchAll(WORD)) {
		const word = match[0].toLowerCase();
		if (allowWords.has(digest(word))) continue;
		for (const slice of slices(word)) {
			if (allowWords.has(digest(slice))) continue;
			const exact = EXACT.get(digest(slice));
			if (exact) found.set(slice, exact);
			// A prefix term stands for a `foo\w*` pattern, and `\w` never spans a hyphen,
			// so it is compared against single segments only. Applied to a compound it
			// would flag an allowed name's versioned form in a lockfile URL as a new term.
			if (slice.includes('-')) continue;
			for (const [length, wanted, what] of PREFIX) {
				if (slice.length >= length && digest(slice.slice(0, length)) === wanted) found.set(slice, what);
			}
		}
	}
	return found;
}

const targets = [
	...trackedFiles(ROOT).map((file) => ({ root: ROOT, file })),
	...extraRoots.flatMap((root) =>
		trackedFiles(root, { required: false })
			.filter((file) => !OPERATIONAL.some((rule) => rule.test(file)))
			.map((file) => ({ root, file })),
	),
];

const hits = [];
for (const { root, file } of targets) {
	if (SKIP_EXT.has(extname(file))) continue;
	let text;
	try {
		text = readFileSync(resolve(root, file), 'utf8');
	} catch {
		continue; // unreadable, a directory (gitlink), or binary — nothing to leak in text form
	}
	const allowWords = ALLOW_BY_FILE.get(file) ?? new Set();
	const allowShapes = PATTERN_ALLOW_BY_FILE.get(file) ?? new Set();
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		for (const [term, what] of findTerms(line, allowWords)) {
			hits.push({ file, line: i + 1, term, what, text: line.trim().slice(0, 160) });
		}
		for (const rule of PATTERNS) {
			if (rule.rootOnly && root !== ROOT) continue;
			if (allowShapes.has(rule.id)) continue;
			const match = rule.re.exec(line);
			if (match) {
				hits.push({ file, line: i + 1, term: match[0], what: rule.what, text: line.trim().slice(0, 160) });
			}
		}
	}
}

if (asJson) {
	console.log(JSON.stringify({ ok: hits.length === 0, hits }, null, 2));
} else if (hits.length === 0) {
	console.log('✓ generalization audit passed — nothing private is named in the source.');
} else {
	console.log(`✗ generalization audit failed — ${hits.length} hit(s)\n`);
	for (const hit of hits) {
		console.log(`  ${hit.file}:${hit.line}  "${hit.term}" (${hit.what})`);
		console.log(`      ${hit.text}`);
	}
	console.log('\nReplace it with product-neutral wording, or — if the mention is legitimate — add it to ALLOW or PATTERN_ALLOW with the reason.');
}

process.exit(hits.length === 0 ? 0 : 1);

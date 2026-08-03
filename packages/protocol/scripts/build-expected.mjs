#!/usr/bin/env node
/**
 * Generate `conformance/expected/*.json` from `conformance/cases/*.json` by running
 * the real zod schemas.
 *
 * WHY THIS IS GENERATED AND NEVER HAND-WRITTEN: the corpus exists so a second
 * implementation (the Go agent) can prove it normalises a frame the same way this
 * one does. An expectation typed by hand only proves that the author and the author's
 * schema agree — the moment a `.default()` changes, a hand-written file changes with
 * it in the same commit and the corpus quietly stops testing anything. Generating it
 * means the diff on `npm run expect:build` IS the behaviour change, visible in review.
 *
 * The cases themselves stay hand-written, for the opposite reason: an input generated
 * from the schema can only exercise what the schema already thinks about.
 *
 * WHAT IT ALSO CHECKS (a corpus that lies is worse than no corpus):
 *   - a case marked `accept` must parse, a case marked `reject` must not;
 *   - ids are unique across every file, because the Go side keys by id;
 *   - every case declares a `why`, so a deleted case can be argued about;
 *   - no orphan expected file survives its cases file.
 *
 * Usage:
 *   node scripts/build-expected.mjs            # write conformance/expected/*.json
 *   node scripts/build-expected.mjs --check    # regenerate in memory, diff, write nothing
 *
 * `--check` is what CI runs: it exits 1 when the committed expectations no longer
 * match what the schemas produce, and touches no file.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CASES_DIR = join(ROOT, 'conformance', 'cases');
const EXPECTED_DIR = join(ROOT, 'conformance', 'expected');
const DIST = join(ROOT, 'dist', 'index.js');

const check = process.argv.slice(2).includes('--check');
const errors = [];

/** The two envelopes every frame in the corpus is parsed with. */
let schemas;
try {
	const protocol = await import(DIST);
	schemas = {
		upstream: protocol.agentUpstreamSchema,
		downstream: protocol.agentDownstreamSchema,
		protocolVersion: protocol.PROTOCOL_VERSION,
	};
} catch (cause) {
	console.error(`Cannot load ${DIST} — run \`npm run build -w @pdmux/protocol\` first.`);
	console.error(String(cause));
	process.exit(1);
}

/**
 * Sort object keys recursively. Arrays keep their order (it is data), objects do not
 * (it is only the schema's declaration order). Sorting makes a regenerated file differ
 * ONLY where behaviour differs — reordering a field in the schema is not a corpus
 * change, and Go's own field order never has to match.
 */
function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== 'object') return value;
	const out = {};
	for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
	return out;
}

const serialise = (value) => `${JSON.stringify(value, null, '\t')}\n`;

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch (cause) {
		errors.push(`${file}: not readable as JSON — ${cause.message}`);
		return null;
	}
}

const caseFiles = readdirSync(CASES_DIR)
	.filter((f) => f.endsWith('.json'))
	.sort();
if (caseFiles.length === 0) errors.push(`${CASES_DIR}: no case files found`);

const seenIds = new Map();
const generated = new Map(); // basename -> serialised expected file

for (const file of caseFiles) {
	const doc = readJson(join(CASES_DIR, file));
	if (!doc) continue;
	if (!Array.isArray(doc.cases)) {
		errors.push(`${file}: missing a top-level "cases" array`);
		continue;
	}

	const accepted = {};
	const rejected = {};

	for (const [index, testCase] of doc.cases.entries()) {
		const at = `${file}[${index}]`;
		const { id, direction, expect, why, frame } = testCase ?? {};

		if (typeof id !== 'string' || id.length === 0) {
			errors.push(`${at}: every case needs a stable string "id"`);
			continue;
		}
		if (seenIds.has(id)) {
			errors.push(`${at}: duplicate id "${id}" (also in ${seenIds.get(id)}) — ids key the expected output`);
			continue;
		}
		seenIds.set(id, file);
		if (direction !== 'upstream' && direction !== 'downstream') {
			errors.push(`${at} (${id}): "direction" must be "upstream" or "downstream"`);
			continue;
		}
		if (expect !== 'accept' && expect !== 'reject') {
			errors.push(`${at} (${id}): "expect" must be "accept" or "reject"`);
			continue;
		}
		if (typeof why !== 'string' || why.trim().length === 0) {
			errors.push(`${at} (${id}): "why" must say what decision this case locks`);
			continue;
		}
		if (frame === undefined) {
			errors.push(`${at} (${id}): missing "frame"`);
			continue;
		}

		const result = schemas[direction].safeParse(frame);
		if (expect === 'accept') {
			if (!result.success) {
				const issue = result.error.issues[0];
				const where = issue?.path.join('.') || '(root)';
				errors.push(`${at} (${id}): declared accept but the schema rejected it — ${where}: ${issue?.message}`);
				continue;
			}
			accepted[id] = sortKeys(result.data);
		} else {
			if (result.success) {
				errors.push(`${at} (${id}): declared reject but the schema ACCEPTED it — the case no longer proves anything`);
				continue;
			}
			const issue = result.error.issues[0];
			rejected[id] = `${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'invalid'}`;
		}
	}

	generated.set(file, serialise({
		// Provenance, so nobody edits this file by hand and wonders why it reverted.
		generatedBy: 'packages/protocol/scripts/build-expected.mjs',
		cases: `conformance/cases/${file}`,
		protocolVersion: schemas.protocolVersion,
		// The contract: a second implementation must produce these values.
		accepted,
		// Informational only — the zod diagnostic. A second implementation asserts THAT
		// the frame was rejected, never this wording (error strings are not a contract).
		rejected,
	}));
}

// An expected file whose cases file was deleted would keep passing forever.
let existing = [];
try {
	existing = readdirSync(EXPECTED_DIR).filter((f) => f.endsWith('.json'));
} catch {
	existing = [];
}
for (const orphan of existing.filter((f) => !generated.has(f))) {
	errors.push(`conformance/expected/${orphan}: no matching cases file — delete it`);
}

if (errors.length > 0) {
	console.error('Conformance corpus is not consistent:\n');
	for (const error of errors) console.error(`  - ${error}`);
	process.exit(1);
}

if (check) {
	const stale = [];
	for (const [file, content] of generated) {
		let committed = null;
		try {
			committed = readFileSync(join(EXPECTED_DIR, file), 'utf8');
		} catch {
			stale.push(`conformance/expected/${file}: missing`);
			continue;
		}
		if (committed !== content) stale.push(`conformance/expected/${file}: differs from what the schemas produce`);
	}
	if (stale.length > 0) {
		console.error('Committed expectations are stale:\n');
		for (const line of stale) console.error(`  - ${line}`);
		console.error('\nRun `npm run expect:build -w @pdmux/protocol` and review the diff: it IS the behaviour change.');
		process.exit(1);
	}
	console.log(`expect:check — ${generated.size} file(s), ${seenIds.size} case(s) match the committed expectations.`);
	process.exit(0);
}

mkdirSync(EXPECTED_DIR, { recursive: true });
for (const [file, content] of generated) writeFileSync(join(EXPECTED_DIR, file), content);
console.log(`expect:build — wrote ${generated.size} file(s) from ${seenIds.size} case(s).`);

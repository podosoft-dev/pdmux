/**
 * The conformance corpus, run on the TypeScript side.
 *
 * WHY A CORPUS AND NOT MORE UNIT TESTS: the host agent is being rewritten in Go. The
 * schemas in `src/` stay the source of truth, but Go cannot run zod — it hand-writes
 * structs and seeds its own defaults. Two implementations of "what does this frame
 * normalise to" drift silently: nothing throws, a field is merely `0` instead of
 * `null`, and a card reads "healthy and idle" for a host whose measurement failed.
 *
 * So the corpus is DATA, not code: `conformance/cases/*.json` are frames, and
 * `conformance/expected/*.json` are what zod produces from them (generated — see
 * `scripts/build-expected.mjs`). This file is the TypeScript half of the proof; the Go
 * test suite loads the same files and must reach the same values.
 *
 * These tests therefore also serve as the sync check: they parse with the SOURCE (not
 * `dist/`), so a schema change that was never regenerated fails here with a diff of the
 * exact field that moved.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	PROTOCOL_VERSION,
	agentDownstreamSchema,
	agentUpstreamSchema,
	compareSemver,
	compareVersionStrings,
	parseSemver,
	type Semver,
} from '../src/index.js';

const CONFORMANCE = join(import.meta.dirname, '..', 'conformance');

interface CorpusCase {
	id: string;
	direction: 'upstream' | 'downstream';
	expect: 'accept' | 'reject';
	why: string;
	frame: unknown;
	/** Which file the case came from — added here, so a failure names it. */
	file: string;
}

interface ExpectedFile {
	protocolVersion: number;
	accepted: Record<string, unknown>;
	rejected: Record<string, string>;
}

const readJson = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(...parts), 'utf8')) as T;

const caseFiles = readdirSync(join(CONFORMANCE, 'cases'))
	.filter((f) => f.endsWith('.json'))
	.sort();

const cases: CorpusCase[] = caseFiles.flatMap((file) => {
	const doc = readJson<{ cases: Omit<CorpusCase, 'file'>[] }>(CONFORMANCE, 'cases', file);
	return doc.cases.map((entry) => ({ ...entry, file }));
});

const expected = new Map<string, ExpectedFile>(
	caseFiles.map((file) => [file, readJson<ExpectedFile>(CONFORMANCE, 'expected', file)]),
);

const acceptCases = cases.filter((c) => c.expect === 'accept');
const rejectCases = cases.filter((c) => c.expect === 'reject');
const schemaFor = (direction: CorpusCase['direction']) =>
	direction === 'upstream' ? agentUpstreamSchema : agentDownstreamSchema;

describe('[TC-PDPROTO-010] the conformance corpus both implementations read', () => {
	it('[TC-PDPROTO-010] covers both directions and both verdicts, with unique ids', () => {
		// A corpus that only proves the happy path proves nothing about a second
		// implementation: the rejections are where a naive port actually differs.
		expect(acceptCases.length).toBeGreaterThan(0);
		expect(rejectCases.length).toBeGreaterThan(0);
		for (const direction of ['upstream', 'downstream'] as const) {
			expect(cases.filter((c) => c.direction === direction && c.expect === 'accept').length).toBeGreaterThan(0);
			expect(cases.filter((c) => c.direction === direction && c.expect === 'reject').length).toBeGreaterThan(0);
		}
		// Ids key the expected output on both sides, so a collision would silently make
		// one case assert another case's value.
		expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
		for (const testCase of cases) expect(testCase.why.trim().length).toBeGreaterThan(0);
	});

	it.each(acceptCases)('[TC-PDPROTO-010] accept $direction/$id normalises to the committed expectation', (testCase) => {
		const result = schemaFor(testCase.direction).safeParse(testCase.frame);
		expect(result.success, `${testCase.id}: ${JSON.stringify(result.error?.issues?.[0])}`).toBe(true);
		// The generated file is the contract. Comparing against `src/` (not `dist/`) means
		// an un-regenerated schema change fails right here, naming the field that moved.
		expect(result.success && result.data).toEqual(expected.get(testCase.file)?.accepted[testCase.id]);
	});

	it.each(rejectCases)('[TC-PDPROTO-010] reject $direction/$id is refused as data', (testCase) => {
		// Refused, never thrown: a bad frame is logged and dropped, and the connection
		// stays up — you cannot tell a broken agent to update if you hung up on it.
		expect(() => schemaFor(testCase.direction).safeParse(testCase.frame)).not.toThrow();
		expect(schemaFor(testCase.direction).safeParse(testCase.frame).success).toBe(false);
	});

	it('[TC-PDPROTO-010] every case has exactly one entry in the generated expectations', () => {
		// Catches the two ways a corpus rots: a case whose expectation was never
		// generated, and an expectation left behind by a deleted case.
		for (const [file, doc] of expected) {
			expect(doc.protocolVersion).toBe(PROTOCOL_VERSION);
			const own = cases.filter((c) => c.file === file);
			expect(Object.keys(doc.accepted).sort()).toEqual(own.filter((c) => c.expect === 'accept').map((c) => c.id).sort());
			expect(Object.keys(doc.rejected).sort()).toEqual(own.filter((c) => c.expect === 'reject').map((c) => c.id).sort());
		}
	});
});

interface SemverParseCase {
	id: string;
	input: string;
	expect: Semver | null;
	why: string;
}

interface SemverCompareCase {
	id: string;
	a: string;
	b: string;
	expect: -1 | 0 | 1 | null;
	why: string;
}

const semverTable = readJson<{ parse: SemverParseCase[]; compare: SemverCompareCase[] }>(CONFORMANCE, 'semver.json');

/**
 * The verdict the mirrored comparison must return. Written out rather than negated:
 * `-0` is not a value this API ever returns, and `toBe` tells the two apart.
 */
function mirrorOf(verdict: -1 | 0 | 1 | null): -1 | 0 | 1 | null {
	if (verdict === null || verdict === 0) return verdict;
	return verdict === 1 ? -1 : 1;
}

describe('[TC-PDPROTO-011] the semver table both implementations read', () => {
	it.each(semverTable.parse)('[TC-PDPROTO-011] parse $id ($input)', (row) => {
		// Unlike the frame corpus, this table is hand-written from the SemVer spec — so a
		// disagreement here is a bug in the parser, not a stale expectation.
		expect(parseSemver(row.input)).toEqual(row.expect);
	});

	it.each(semverTable.compare)('[TC-PDPROTO-011] compare $id ($a vs $b)', (row) => {
		expect(compareVersionStrings(row.a, row.b)).toBe(row.expect);
		// Antisymmetry, for free: every row is also its own mirror, so no row can be
		// satisfied by a comparator that got the sign right in only one direction.
		expect(compareVersionStrings(row.b, row.a)).toBe(mirrorOf(row.expect));
	});

	it('[TC-PDPROTO-011] the table exercises the edges people actually get wrong', () => {
		// Guards against the table being quietly trimmed to the easy rows: each of these
		// is a real divergence between a spec-correct comparator and a plausible one.
		const parseIds = new Set(semverTable.parse.map((row) => row.id));
		for (const id of ['invalid-leading-zero-core', 'invalid-numeric-leading-zero-prerelease', 'prerelease-alphanumeric-leading-zero', 'invalid-v-prefix']) {
			expect(parseIds).toContain(id);
		}
		const compareIds = new Set(semverTable.compare.map((row) => row.id));
		for (const id of ['prerelease-below-release', 'build-metadata-ignored', 'patch-numeric-not-lexical', 'numeric-identifier-below-alphanumeric', 'fewer-identifiers-first']) {
			expect(compareIds).toContain(id);
		}
		expect(semverTable.parse.some((row) => row.expect === null)).toBe(true);
	});

	it('[TC-PDPROTO-011] compares parsed values directly, not only strings', () => {
		// compareSemver is what the agent calls when it refuses a downgrade; the string
		// wrapper is a convenience, and both must agree on every row.
		for (const row of semverTable.compare) {
			const left = parseSemver(row.a);
			const right = parseSemver(row.b);
			if (!left || !right) {
				expect(row.expect).toBeNull();
				continue;
			}
			expect(compareSemver(left, right)).toBe(row.expect);
		}
	});
});

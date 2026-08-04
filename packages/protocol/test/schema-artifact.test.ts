/**
 * The generated artefact's own tests.
 *
 * `schema/protocol.schema.json` is what the Go agent embeds, so it is the point
 * where the contract stops being TypeScript and becomes bytes another language
 * reads. Three failures are possible there and none of them is loud on its own:
 *
 *  1. The committed file drifts from `src/index.ts` — someone adds a field and
 *     regenerates nothing, so Go keeps a stale idea of the wire.
 *  2. `additionalProperties` flips to `false` (the generator's default for a zod
 *     `strip` object). Then a schema-driven Go reader REJECTS the frames zod
 *     accepts, which inverts the compatibility rule TC-PDPROTO-007 pins.
 *  3. A constant that only lives in TypeScript (`AGENT_WS_PATH`, `DIFF_CAPS`)
 *     changes, and nothing in the schema forces it to move.
 *
 * Each is asserted below against the committed bytes, so the test fails in the
 * same place, and for the same reason, as `npm run schema:check -w @pdmux/protocol`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildSchema, serialize } from '../scripts/build-schema.mjs';
import {
	AGENT_CLOSE_HOST_DELETED,
	AGENT_CLOSE_HOST_DISABLED,
	AGENT_CLOSE_REPLACED,
	AGENT_CLOSE_TOKEN_REVOKED,
	AGENT_KEY_HEADER,
	AGENT_WS_PATH,
	DIFF_CAPS,
	EXEC_OUTPUT_MAX,
	MIN_SUPPORTED_AGENT,
	PROTOCOL_VERSION,
	TERMINAL_WS_PATH,
} from '../src/index.js';
import * as protocol from '../src/index.js';

type JsonObject = Record<string, unknown>;

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
const committedSchemaText = readFileSync(join(SCHEMA_DIR, 'protocol.schema.json'), 'utf8');
const committedConstantsText = readFileSync(join(SCHEMA_DIR, 'constants.json'), 'utf8');
const committedSchema = JSON.parse(committedSchemaText) as JsonObject;
const committedConstants = JSON.parse(committedConstantsText) as JsonObject;

const built = buildSchema(protocol);
const defs = committedSchema.$defs as Record<string, JsonObject>;

/**
 * Every `$defs` entry the Go generator turns into a type. Frozen deliberately:
 * these names are the mapping key, so a rename is a Go-side break and has to be
 * a decision, not a side effect of renaming an export.
 */
const EXPECTED_DEFS = [
	'agentCapability',
	'agentConfig',
	'agentDiagnostic',
	'agentDownstream',
	'agentExec',
	'agentHello',
	'agentServiceConfig',
	'agentUpdate',
	'agentUpdateAbility',
	'agentUpstream',
	'agentUsage',
	'commitDetail',
	'diffFile',
	'epochSeconds',
	'execResult',
	'gitCommit',
	'gitHead',
	'gitRef',
	// Added with the on-demand remote check. `gitRemoteRef` is deliberately not
	// `gitRef`: one is a local pointer (including remote-TRACKING refs, which are
	// as old as the last fetch) and the other is what the remote advertises now.
	'gitRemoteCheck',
	'gitRemoteRef',
	'gitStatusFile',
	'gitUncommitted',
	'heartbeat',
	'listener',
	'muxSession',
	'percent',
	'repoSnapshot',
	'resource',
	'serviceProbe',
	'terminalClientFrame',
	'terminalServerFrame',
	'terminalTarget',
	'updateStatus',
	'usageWindow',
	'workingDiff',
];

function isPlainObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Visit every node in the document, carrying the JSON pointer that reaches it. */
function walk(node: unknown, pointer: string, visit: (node: JsonObject, pointer: string) => void): void {
	if (Array.isArray(node)) {
		node.forEach((item, index) => walk(item, `${pointer}/${index}`, visit));
		return;
	}
	if (!isPlainObject(node)) return;
	visit(node, pointer);
	for (const [key, value] of Object.entries(node)) {
		walk(value, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, visit);
	}
}

function collectObjectNodes(): { pointer: string; node: JsonObject }[] {
	const found: { pointer: string; node: JsonObject }[] = [];
	walk(committedSchema, '', (node, pointer) => {
		if (node.type === 'object') found.push({ pointer, node });
	});
	return found;
}

describe('[TC-PDPROTO-013] the generated schema artefact', () => {
	it('[TC-PDPROTO-013] is byte-identical to what src/index.ts produces right now', () => {
		// Same comparison `--check` makes, so a stale commit fails here first —
		// in a test run, rather than in a Go build on someone else's machine.
		expect(committedSchemaText).toBe(serialize(built.schema));
		expect(committedConstantsText).toBe(serialize(built.constants));
		expect(committedSchema).toEqual(built.schema);
		expect(committedConstants).toEqual(built.constants);
	});

	it('[TC-PDPROTO-013] ends every file with a newline and sorted keys, so a diff means a change', () => {
		for (const text of [committedSchemaText, committedConstantsText]) {
			expect(text.endsWith('\n')).toBe(true);
			expect(text.endsWith('\n\n')).toBe(false);
			const keys = Object.keys(JSON.parse(text) as JsonObject);
			expect(keys).toEqual([...keys].sort());
		}
		// Sorting is recursive or it is not a guarantee.
		expect(Object.keys(defs)).toEqual([...Object.keys(defs)].sort());
		const heartbeat = defs.heartbeat?.properties as JsonObject;
		expect(Object.keys(heartbeat)).toEqual([...Object.keys(heartbeat)].sort());
	});

	it('[TC-PDPROTO-013] leaves every object open to unknown fields', () => {
		// THE INVERSION THIS GUARDS: zod strips unknown keys (TC-PDPROTO-007), but
		// zod-to-json-schema writes `additionalProperties: false` for a strip object
		// by default. A Go reader built from that would reject exactly the frames a
		// newer server sends to an older agent. Checked over EVERY object node, not
		// just the two roots, because one nested object is enough to drop a frame.
		const objects = collectObjectNodes();
		const closed = objects.filter(({ node }) => node.additionalProperties !== true);
		expect(closed.map(({ pointer }) => pointer)).toEqual([]);
		// A walk that finds nothing would pass vacuously.
		expect(objects.length).toBeGreaterThan(40);
	});

	it('[TC-PDPROTO-013] names every subschema the Go generator maps to a type', () => {
		expect(Object.keys(defs).sort()).toEqual(EXPECTED_DEFS);
	});

	it('[TC-PDPROTO-013] declares both directions as roots and resolves them', () => {
		const roots = committedSchema.roots as Record<string, JsonObject>;
		expect(Object.keys(roots).sort()).toEqual(['agentDownstream', 'agentUpstream']);
		expect(roots.agentUpstream).toEqual({ $ref: '#/$defs/agentUpstream' });
		expect(roots.agentDownstream).toEqual({ $ref: '#/$defs/agentDownstream' });
		// Both roots are unions of frames, not objects.
		expect(Array.isArray(defs.agentUpstream?.anyOf)).toBe(true);
		expect(Array.isArray(defs.agentDownstream?.anyOf)).toBe(true);
	});

	it('[TC-PDPROTO-013] points every $ref at a top-level $def', () => {
		// A ref into a field's serialisation (`#/$defs/usageWindow/properties/...`)
		// is valid JSON Schema and useless to a type generator — and it moves the
		// moment a field is reordered.
		const refs: string[] = [];
		walk(committedSchema, '', (node) => {
			if (typeof node.$ref === 'string') refs.push(node.$ref);
		});
		expect(refs.length).toBeGreaterThan(30);
		const strays = [...new Set(refs)].filter((ref) => {
			const match = /^#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/.exec(ref);
			return match === null || !(match[1] in defs);
		});
		expect(strays).toEqual([]);
	});
});

describe('[TC-PDPROTO-013] the generated constants artefact', () => {
	it('[TC-PDPROTO-013] carries exactly the values exported from src/index.ts', () => {
		const values = Object.fromEntries(
			Object.entries(committedConstants).filter(([key]) => !key.startsWith('$') && !key.startsWith('_')),
		);
		expect(values).toEqual({
			AGENT_CLOSE_HOST_DELETED,
			AGENT_CLOSE_HOST_DISABLED,
			AGENT_CLOSE_REPLACED,
			AGENT_CLOSE_TOKEN_REVOKED,
			AGENT_KEY_HEADER,
			AGENT_WS_PATH,
			DIFF_CAPS,
			EXEC_OUTPUT_MAX,
			MIN_SUPPORTED_AGENT,
			PROTOCOL_VERSION,
			TERMINAL_WS_PATH,
		});
		// Spelled out as well as compared, so a rename in src cannot quietly rename
		// the key the Go side reads.
		expect(values.AGENT_WS_PATH).toBe('/agent/ws');
		expect(values.TERMINAL_WS_PATH).toBe('/terminal/ws');
		expect(values.AGENT_KEY_HEADER).toBe('x-api-key');
		expect(values.PROTOCOL_VERSION).toBe(1);
		// ⚠ The `-0` is deliberate: a prerelease sorts below its release, so a floor of
	// plain `0.1.0` would mark every agent compiled from a working tree
	// (`0.1.0-dev.3+g1a2b3c`) as `incompatible`. See src/semver.ts.
	expect(values.MIN_SUPPORTED_AGENT).toBe('0.1.0-0');
		expect(values.DIFF_CAPS).toEqual({ maxBytes: 200_000, maxFileLines: 800, maxLineChars: 500 });
		// The numbers themselves, because the agent decides what to record from the
		// code alone — a value that moved would turn a deliberate disconnect into
		// something the agent files as an ordinary network drop.
		expect(values.AGENT_CLOSE_REPLACED).toBe(4000);
		expect(values.AGENT_CLOSE_HOST_DISABLED).toBe(4002);
		expect(values.AGENT_CLOSE_TOKEN_REVOKED).toBe(4003);
		expect(values.AGENT_CLOSE_HOST_DELETED).toBe(4004);
		// ⚠ 4001 must stay OUT: the terminal relay uses it toward browsers, and one
		// number meaning two things is what makes a grep through logs lie.
		expect(Object.values(values)).not.toContain(4001);
	});
});

describe('[TC-PDPROTO-013] what the Go side reads out of the artefact', () => {
	it('[TC-PDPROTO-013] states a default wherever zod substitutes one, and never marks it required', () => {
		// This is the whole reason the artefact exists: "absent" and "zero" are
		// different, and the difference is decided here rather than re-guessed in Go.
		let compared = 0;
		for (const [exportName, value] of Object.entries(protocol)) {
			if (!value || typeof value !== 'object') continue;
			const schema = value as { safeParse?: (input: unknown) => { success: boolean; data?: unknown } };
			if (typeof schema.safeParse !== 'function') continue;
			const name = exportName.endsWith('Schema') ? exportName.slice(0, -'Schema'.length) : exportName;
			const def = defs[name];
			const properties = def?.properties;
			if (!isPlainObject(properties)) continue;
			const parsed = schema.safeParse({});
			if (!parsed.success || !isPlainObject(parsed.data)) continue;
			const required = Array.isArray(def?.required) ? (def.required as string[]) : [];
			for (const [field, filled] of Object.entries(parsed.data)) {
				const property = properties[field];
				expect(isPlainObject(property)).toBe(true);
				if (!isPlainObject(property)) continue;
				expect(property).toHaveProperty('default');
				expect(property.default).toEqual(filled);
				expect(required).not.toContain(field);
				compared += 1;
			}
		}
		expect(compared).toBeGreaterThan(40);
	});

	it('[TC-PDPROTO-013] distinguishes an optional field from a defaulted one', () => {
		// `label` and `session` are `.optional()` with no default: absent stays
		// absent, and Go needs a pointer rather than a zero value.
		const label = defs.usageWindow?.properties as JsonObject;
		expect(isPlainObject(label.label) && 'default' in label.label).toBe(false);
		expect(defs.usageWindow?.required).toEqual(['key']);
		const target = defs.terminalTarget?.properties as JsonObject;
		expect(isPlainObject(target.session) && 'default' in target.session).toBe(false);
		expect(defs.terminalTarget).not.toHaveProperty('required');
	});

	it('[TC-PDPROTO-013] keeps the string constraints that are security controls', () => {
		// The session name is interpolated into `tmux new -A -s <name>` on the host.
		// If this pattern does not reach Go, the shell-metacharacter rejection that
		// TC-PDPROTO-004 pins exists only in TypeScript.
		const target = defs.terminalTarget?.properties as JsonObject;
		const session = target.session as JsonObject;
		expect(session.pattern).toBe('^[A-Za-z0-9_-]{1,32}$');
		const pattern = new RegExp(session.pattern as string);
		expect(pattern.test('main-1_x')).toBe(true);
		for (const bad of ['a b', 'a;rm -rf /', '$(id)', '../etc', 'x'.repeat(33)]) {
			expect(pattern.test(bad)).toBe(false);
		}

		const update = defs.agentUpdate?.properties as JsonObject;
		expect((update.sha256 as JsonObject).pattern).toBe('^[0-9a-f]{64}$');
		// `format` is an annotation, not an assertion — Go has to enforce these
		// three by hand, so at minimum they must be visible in the artefact.
		expect((update.commandId as JsonObject).format).toBe('uuid');
		expect(((defs.serviceProbe?.properties as JsonObject).id as JsonObject).format).toBe('uuid');
		expect(((defs.agentServiceConfig?.properties as JsonObject).id as JsonObject).format).toBe('uuid');
	});

	it('[TC-PDPROTO-013] leaves every union branch tagged with a const discriminator', () => {
		// zod's `discriminatedUnion` becomes a plain `anyOf`, so the fact that `type`
		// selects the branch survives only as a `const` on each branch. Go recovers
		// the discriminator from these; if one branch ever lost its literal, a
		// decoder would have to try every shape and could pick the wrong one.
		for (const name of ['agentUpstream', 'agentDownstream', 'terminalClientFrame', 'terminalServerFrame']) {
			const branches = defs[name]?.anyOf as JsonObject[];
			expect(branches.length).toBeGreaterThan(3);
			const discriminators = branches.map((branch) => {
				const properties = branch.properties as JsonObject;
				return (properties.type as JsonObject).const;
			});
			expect(discriminators.every((value) => typeof value === 'string')).toBe(true);
			expect(new Set(discriminators).size).toBe(discriminators.length);
			expect(branches.every((branch) => (branch.required as string[]).includes('type'))).toBe(true);
		}
		const upstream = (defs.agentUpstream?.anyOf as JsonObject[]).map(
			(branch) => ((branch.properties as JsonObject).type as JsonObject).const,
		);
		expect(upstream).toEqual(['hello', 'heartbeat', 'repos', 'terminal', 'pong', 'updateStatus', 'execResult']);
	});

	it('[TC-PDPROTO-013] marks itself generated without constraining the roots', () => {
		for (const document of [committedSchema, committedConstants]) {
			expect(document.$comment).toContain('do not hand-edit');
			expect(document.$comment).toContain('npm run schema:build -w @pdmux/protocol');
			const marker = document._generated as JsonObject;
			expect(marker.doNotEdit).toBe(true);
			expect(marker.command).toBe('npm run schema:build -w @pdmux/protocol');
			expect(marker.source).toBe('packages/protocol/src/index.ts');
		}
		expect((committedSchema._generated as JsonObject).protocolVersion).toBe(PROTOCOL_VERSION);
		// The markers are document-level annotations. `#/$defs/agentUpstream` — what
		// a validator or generator actually resolves — carries no trace of them.
		for (const root of ['agentUpstream', 'agentDownstream']) {
			expect(Object.keys(defs[root] as JsonObject)).toEqual(['anyOf']);
		}
		expect(committedSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
	});
});

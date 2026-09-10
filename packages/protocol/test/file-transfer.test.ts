import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as browserLimits from '../src/transfer-limits.js';
import * as canonical from '../src/index.js';
import { agentDownstreamSchema, agentUpstreamSchema, fsTransferRequestSchema, fsTransferResultSchema } from '../src/index.js';

const ids = {
	requestId: '11111111-1111-4111-8111-111111111111',
	transferId: '22222222-2222-4222-8222-222222222222',
	entryId: '33333333-3333-4333-8333-333333333333',
};

describe('[TC-PDFILE-003] bounded transfer contract', (): void => {
	it('shares browser limits without loading the schema runtime', (): void => {
		for (const [key, value] of Object.entries(browserLimits)) {
			expect(value).toBe(canonical[key as keyof typeof canonical]);
		}
		const source = readFileSync(new URL('../src/transfer-limits.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/\bimport\s+(?!type\b)/);
		expect(source).not.toMatch(/export\s+(?!type\b)[^;]*\bfrom\s/);
	});
	it('defaults optional request and result fields', (): void => {
		const transfer = fsTransferRequestSchema.parse({ ...ids, action: 'stat', path: 'folder/file' });
		expect(transfer.offset).toBe(0);
		expect(transfer.replace).toBe(false);
		expect(agentDownstreamSchema.parse({ type: 'fsTransfer', transfer }).type).toBe('fsTransfer');
		const result = fsTransferResultSchema.parse(ids);
		expect(result.entries).toEqual([]);
		expect(agentUpstreamSchema.parse({ type: 'fsTransferResult', result }).type).toBe('fsTransferResult');
	});
	it('rejects unbounded data, paths, page sizes and offsets', (): void => {
		const request = { ...ids, action: 'write', path: 'file' };
		for (const invalid of [{ data: 'x'.repeat(2_097_153) }, { path: 'x'.repeat(1025) }, { offset: -1 }, { size: 10 * 1024 ** 3 + 1 }]) {
			expect(fsTransferRequestSchema.safeParse({ ...request, ...invalid }).success).toBe(false);
		}
		expect(fsTransferResultSchema.safeParse({ ...ids, entries: Array.from({ length: 251 }, () => ({ path: 'x', kind: 'file' })) }).success).toBe(false);
	});
});

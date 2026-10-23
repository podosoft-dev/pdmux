import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ObjectStore } from '@podosoft/podokit-runtime';
import { commitDetailSchema, workingDiffSchema } from '@pdmux/protocol';
import { GitDetailService } from './git-detail.service';

const fixture = (JSON.parse(readFileSync(resolve(process.cwd(), '../../agent/internal/git/testdata/diff-paths.json'), 'utf8')) as { path: string; legacyPath: string }[])[0]!;
const host = '11111111-1111-4111-8111-111111111111';
const repo = '22222222-2222-4222-8222-222222222222';

describe('[TC-PDGIT-056] old stored patch paths', () => {
  it('repairs commit and working-tree reads without rewriting the stored object', async () => {
    let puts = 0;
    let payload = JSON.stringify(commitDetailSchema.parse({ sha: 'a'.repeat(40), files: [{ path: fixture.legacyPath, add: 4, del: 1, lines: ['-old', '+new'] }] }));
    const storage = { get: async () => ({ body: new Response(payload).body }), put: async () => { puts++; } } as unknown as ObjectStore;
    const service = new GitDetailService(storage);
    const detail = await service.getCommitDetail(host, repo, 'a'.repeat(40));
    expect(detail?.files[0]?.path).toBe(fixture.path);
    expect(detail?.files[0]?.add).toBe(4);
    expect(JSON.parse(payload).files[0].path).toBe(fixture.legacyPath);
    payload = JSON.stringify(workingDiffSchema.parse({ staged: [{ path: fixture.legacyPath }], unstaged: [{ path: fixture.legacyPath }], untracked: [{ path: fixture.path }] }));
    const working = await service.getWorkingDiff(host, repo);
    expect([working?.staged[0]?.path, working?.unstaged[0]?.path, working?.untracked[0]?.path]).toEqual([fixture.path, fixture.path, fixture.path]);
    expect(puts).toBe(0);
  });
});

import type { RepoGraphResponse, RepoRow } from "../../src/lib/dashboard/types";

export const OLD_SHA = "a".repeat(40);
export const NEW_SHA = "b".repeat(40);

export function repository(patch: Partial<RepoRow> = {}): RepoRow {
  return {
    id: "11111111-1111-4111-8111-111111111111", hostId: "h1", path: "/work/repo", name: "repo",
    headBranch: "main", headSha: OLD_SHA, detached: false, ahead: 0, behind: 0,
    dirtyCount: 0, dirtySubmodules: 0, truncated: false, limit: 300, pendingDetails: 0,
    hasWorkingDiff: false, lastSnapshotAt: "2026-09-07T00:00:00.000Z", error: null,
    remoteRefs: null, remoteCheckedAt: null, remoteError: null, ...patch,
  };
}

export function graphSnapshot(repo: RepoRow = repository()): RepoGraphResponse {
  const shas = repo.headSha === NEW_SHA ? [NEW_SHA, OLD_SHA] : [OLD_SHA];
  return {
    repo,
    refs: [{ id: "ref", repoId: repo.id, name: "main", kind: "local", sha: repo.headSha ?? OLD_SHA,
      upstream: null, ahead: 0, behind: 0, gone: false }],
    commits: shas.map((sha, index) => ({ sha, parents: shas.slice(index + 1),
      refs: index === 0 ? ["main"] : [], author: "Tester", date: "2026-09-07T00:00:00.000Z",
      subject: sha === NEW_SHA ? "Newly collected commit" : "Original commit", hasDetail: true })),
  };
}

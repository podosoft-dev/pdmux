/**
 * Object-storage keys for git payloads, and the guards that keep a hostile value
 * from escaping the prefix.
 *
 * WHY OBJECT STORAGE: a full window is ~4,200 patches averaging 24KB (measured on
 * a 15-repo, 2-machine fleet) — ~96MB per fleet pass that is written once, read on
 * a click, and never queried. That is a blob store's job; in Postgres it is dead
 * weight in every backup and every sequential scan.
 */

const SHA = /^[0-9a-f]{7,40}$/;
const UUID = /^[0-9a-f-]{36}$/i;

export function isValidSha(sha: string): boolean {
  return SHA.test(sha);
}

function assertIds(hostId: string, repoId: string): void {
  // Ids come from our own tables, but a key is a path: a single unchecked value
  // with ".." in it would let one repo's click read another's object.
  if (!UUID.test(hostId) || !UUID.test(repoId)) throw new Error("Invalid storage id");
}

export function repoPrefix(hostId: string, repoId: string): string {
  assertIds(hostId, repoId);
  return `hosts/${hostId}/repos/${repoId}`;
}

export function commitDetailKey(hostId: string, repoId: string, sha: string): string {
  if (!isValidSha(sha)) throw new Error("Invalid commit sha");
  return `${repoPrefix(hostId, repoId)}/${sha}.json`;
}

/** The working tree is rewritten every pass, so it gets one stable key. */
export function workingDiffKey(hostId: string, repoId: string): string {
  return `${repoPrefix(hostId, repoId)}/working.json`;
}

/**
 * A commit's file listing — the paths that existed at it, with their sizes.
 *
 * ⚠ THE LISTING IS STORED AND THE FILES ARE NOT. A listing is one bounded object
 * per commit (5,000 paths at ~60 bytes), it is immutable per sha exactly like the
 * patch beside it, and it is what every click in the file tree reads. A file's
 * CONTENTS are the opposite on all three counts: unbounded, one per path rather
 * than per commit, and read once — so they never reach this bucket at all. See
 * `git-blob-buffer.service.ts`.
 */
export function fileTreeKey(hostId: string, repoId: string, sha: string): string {
  if (!isValidSha(sha)) throw new Error("Invalid commit sha");
  return `${repoPrefix(hostId, repoId)}/${sha}.tree.json`;
}

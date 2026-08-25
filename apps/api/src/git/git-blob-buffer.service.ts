import { ProductLogger } from "../logging/product-logger";
import type { GitBlob } from "@pdmux/protocol";

/**
 * File contents in transit, and nowhere else.
 *
 * ⚠ A FILE'S CONTENTS NEVER REACH THE OBJECT STORE, and that is a decision rather
 * than an omission. A commit's patch and its file LISTING are both bounded, both
 * immutable per sha, and both read on every visit — they belong on disk. A file's
 * contents are none of those: unbounded in size, one object per (sha, path) so a
 * person browsing a tree mints a new one per click, and read exactly once because
 * the browser caches what it was given. Storing them would grow the bucket with
 * every click forever, for content nobody asks for twice.
 *
 * So this holds one thing only: the gap between the agent's WebSocket answer and
 * the browser's follow-up GET. It is a few hundred milliseconds. Anything still
 * here after {@link BLOB_TTL_MS} was never collected and is dropped; anything past
 * the caps evicts the oldest.
 *
 * A miss is not an error — the client simply asks again, which costs one
 * `git show` on the host. That is the trade this service exists to make.
 */
export class GitBlobBufferService {
  private readonly logger = new ProductLogger(GitBlobBufferService.name);
  /** Insertion-ordered, which is what makes the oldest entry the first key. */
  private readonly entries = new Map<string, { blob: GitBlob; expiresAt: number; bytes: number }>();
  private bytes = 0;

  /**
   * `now` is a parameter for the same reason `AgentDetailRequestService.request`
   * takes one: expiry is behaviour worth asserting, and a spec should not sleep
   * for a minute to assert it.
   */
  put(repoId: string, blob: GitBlob, now: number = Date.now()): void {
    this.expire(now);
    const key = bufferKey(repoId, blob.sha, blob.path);
    this.drop(key);
    const bytes = estimate(blob);
    this.entries.set(key, { blob, expiresAt: now + BLOB_TTL_MS, bytes });
    this.bytes += bytes;
    this.evict();
  }

  /**
   * Reads and REMOVES. The browser is the cache; leaving a copy here after it has
   * been handed over would keep every file anyone opened resident for the TTL, for
   * a second read that the client's own cache makes.
   */
  take(repoId: string, sha: string, path: string, now: number = Date.now()): GitBlob | null {
    this.expire(now);
    const key = bufferKey(repoId, sha, path);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.drop(key);
    return entry.blob;
  }

  /** In-flight entries right now — what the caps are measured against. */
  size(): number {
    return this.entries.size;
  }

  private drop(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.bytes -= existing.bytes;
    this.entries.delete(key);
  }

  private expire(now: number): void {
    for (const [key, entry] of this.entries) {
      // Insertion order is not expiry order only if the TTL ever varies; it does
      // not, so the first entry that is still alive ends the sweep.
      if (entry.expiresAt > now) break;
      this.drop(key);
    }
  }

  /** Oldest first, until both ceilings are satisfied. */
  private evict(): void {
    while (this.entries.size > BLOB_BUFFER_MAX_ENTRIES || this.bytes > BLOB_BUFFER_MAX_BYTES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.logger.debug(`Evicting a buffered file before it was read: ${oldest.value}`);
      this.drop(oldest.value);
    }
  }
}

/**
 * How long a delivered file waits to be collected.
 *
 * The browser asks again within a poll interval of the agent answering, so this is
 * sized for the other case — an answer nobody came back for — where the only cost
 * of being wrong is one extra `git show`.
 */
export const BLOB_TTL_MS = 60_000;

/**
 * Ceilings, so a script sweeping a tree cannot turn this into a heap of the
 * repository. Both are needed: one 4,000-line file is nothing like 200 small ones.
 */
export const BLOB_BUFFER_MAX_ENTRIES = 200;
export const BLOB_BUFFER_MAX_BYTES = 32_000_000;

/** NUL cannot appear in an id, a sha or a path, so the key cannot collide. */
const KEY_SEPARATOR = "\u0000";

function bufferKey(repoId: string, sha: string, path: string): string {
  return `${repoId}${KEY_SEPARATOR}${sha}${KEY_SEPARATOR}${path}`;
}

/** Close enough to bound memory: the lines are the payload, the rest is noise. */
function estimate(blob: GitBlob): number {
  let bytes = blob.path.length + 64;
  for (const line of blob.lines) bytes += line.length + 8;
  return bytes;
}

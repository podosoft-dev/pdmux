import { ProductLogger } from "../logging/product-logger";
import type { CommitDetail, GitTree, WorkingDiff } from "@pdmux/protocol";
import type { ObjectStore } from "../storage/object-store";
import { commitDetailKey, fileTreeKey, workingDiffKey } from "./git-storage";

/**
 * Reads/writes the git payloads that live in object storage.
 *
 * A missing object is `null`, not an exception: "not collected yet" is a normal
 * state of this system (a cold start fills the window over several passes), and
 * the UI needs to say "still collecting" rather than show a failure.
 */
export class GitDetailService {
  private readonly logger = new ProductLogger(GitDetailService.name);

  constructor(private readonly storage: ObjectStore) {}

  async putCommitDetail(hostId: string, repoId: string, detail: CommitDetail): Promise<void> {
    await this.storage.put(
      commitDetailKey(hostId, repoId, detail.sha),
      JSON.stringify(detail),
      "application/json",
    );
  }

  async getCommitDetail(hostId: string, repoId: string, sha: string): Promise<CommitDetail | null> {
    return this.readJson<CommitDetail>(commitDetailKey(hostId, repoId, sha));
  }

  /**
   * A commit's file listing.
   *
   * ⚠ IMMUTABLE PER SHA, like the patch — the tree of a commit cannot change — so
   * this is written once and never rewritten, which is what makes a re-sent frame
   * free. It is pruned with the commit row, not on its own schedule.
   */
  async putFileTree(hostId: string, repoId: string, tree: GitTree): Promise<void> {
    await this.storage.put(
      fileTreeKey(hostId, repoId, tree.sha),
      JSON.stringify(tree),
      "application/json",
    );
  }

  async getFileTree(hostId: string, repoId: string, sha: string): Promise<GitTree | null> {
    return this.readJson<GitTree>(fileTreeKey(hostId, repoId, sha));
  }

  async deleteFileTree(hostId: string, repoId: string, sha: string): Promise<void> {
    try {
      await this.storage.delete(fileTreeKey(hostId, repoId, sha));
    } catch (error) {
      // Already gone is the outcome this call wants, same as the patch beside it.
      this.logger.debug(`Delete file tree failed repo=${repoId} sha=${sha}: ${String(error)}`);
    }
  }

  async putWorkingDiff(hostId: string, repoId: string, diff: WorkingDiff): Promise<void> {
    await this.storage.put(
      workingDiffKey(hostId, repoId),
      JSON.stringify(diff),
      "application/json",
    );
  }

  async getWorkingDiff(hostId: string, repoId: string): Promise<WorkingDiff | null> {
    return this.readJson<WorkingDiff>(workingDiffKey(hostId, repoId));
  }

  async deleteWorkingDiff(hostId: string, repoId: string): Promise<void> {
    try {
      await this.storage.delete(workingDiffKey(hostId, repoId));
    } catch (error) {
      // Deleting an object that is already gone is the desired end state.
      this.logger.debug(`Delete working diff failed repo=${repoId}: ${String(error)}`);
    }
  }

  /**
   * Drops the patch of a sha the reported window no longer contains (a rewritten
   * or abandoned commit).
   *
   * ⚠ ONLY FOR A SHA WHOSE ROW IS ALREADY GONE. While the row exists this object is
   * immutable and must never be rewritten or removed — that invariant is what makes
   * a re-sent snapshot free. Once the row is pruned the object is unreachable (a
   * click resolves through the row), so leaving it behind is pure garbage that grows
   * with every rebase.
   *
   * Never throws, for the same reason as above: an object that is already gone is
   * the outcome this call wants.
   */
  async deleteCommitDetail(hostId: string, repoId: string, sha: string): Promise<void> {
    try {
      await this.storage.delete(commitDetailKey(hostId, repoId, sha));
    } catch (error) {
      this.logger.debug(`Delete commit detail failed repo=${repoId} sha=${sha}: ${String(error)}`);
    }
  }

  private async readJson<T>(key: string): Promise<T | null> {
    try {
      const body = await this.storage.get(key);
      if (body.length === 0) return null;
      return JSON.parse(body.toString("utf8")) as T;
    } catch (error) {
      this.logger.debug(`Read ${key} failed: ${String(error)}`);
      return null;
    }
  }
}

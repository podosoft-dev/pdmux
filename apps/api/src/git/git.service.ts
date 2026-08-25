import { ProductLogger } from "../logging/product-logger";
import { Repository } from "typeorm";
import type { CommitDetail, GitBlob, GitTree, WorkingDiff } from "@pdmux/protocol";
import { AppException } from "../common/app-exception";
import { HostsService } from "../hosts/hosts.service";
import { stableTopoOrder } from "./commit-order";
import { GitBlobBufferService } from "./git-blob-buffer.service";
import { GitDetailService } from "./git-detail.service";
import { isValidSha } from "./git-storage";
import { RepoCommit } from "./repo-commit.entity";
import { RepoRef } from "./repo-ref.entity";
import { Repo } from "./repo.entity";

/** Graph payload: rows only. No bodies, no patches — those are a click away. */
export interface RepoGraph {
  repo: Repo;
  refs: RepoRef[];
  commits: {
    sha: string;
    parents: string[];
    refs: string[];
    author: string;
    date: string | null;
    subject: string;
    hasDetail: boolean;
  }[];
}

/**
 * "Not collected yet" is a first-class answer, not an error.
 *
 * A cold start fills the window over several passes, so a click can legitimately
 * land on a commit whose patch does not exist yet. Returning 404 there taught
 * users the feature was broken; returning `pending` lets the UI say
 * "still collecting (N left)".
 */
export interface DetailResponse<T> {
  available: boolean;
  detail: T | null;
  pending: number;
}

/**
 * Asks the host's agent to produce a detail this server does not have.
 *
 * WHY A LISTENER AND NOT AN INJECTED SENDER: talking to an agent means the
 * registry, which lives in `AgentsModule` — and `AgentsModule` already imports
 * `GitModule` (the ack service reads from it). Injecting it back would be a
 * circular provider needing a `forwardRef`. The agents side registers here at
 * startup instead, the same late binding `FleetSettingsService.setChangeListener`
 * and `HostsService.setConnectedProbe` use.
 *
 * ⚠ MUST NOT THROW AND MUST NOT BLOCK: it is called from a plain GET. It writes a
 * frame and returns; the detail comes back later through the normal ingest path.
 *
 * Returns true when a request for that sha is OUTSTANDING after the call — either
 * this one, or one still waiting for an answer. False means nobody is going to
 * bring it (host offline, or the send failed), which is what lets the response
 * below say "collecting" only when it is true.
 */
export type CommitDetailRequestListener = (
  hostId: string,
  repoPath: string,
  request: AgentGitRequest,
) => boolean;

/**
 * What a click needs the agent to produce.
 *
 * ⚠ ONE LISTENER, THREE KINDS, ON PURPOSE. The coalescing, the TTL and the
 * per-host ceiling in `AgentDetailRequestService` are the reason a polling browser
 * does not turn into a flood of `git show` on somebody's machine, and a second
 * request path would have had to reinvent all three — or, more likely, none.
 */
export type AgentGitRequest =
  | { kind: "detail"; sha: string }
  | { kind: "tree"; sha: string }
  | { kind: "blob"; sha: string; path: string };

export class GitService {
  private readonly logger = new ProductLogger(GitService.name);
  private detailRequestListener: CommitDetailRequestListener = () => false;

  constructor(
    private readonly repos: Repository<Repo>,
    private readonly refs: Repository<RepoRef>,
    private readonly commits: Repository<RepoCommit>,
    private readonly details: GitDetailService,
    private readonly blobs: GitBlobBufferService,
    private readonly hosts: HostsService,
  ) {}

  /** Called once by the agents side at startup (avoids a circular provider). */
  setDetailRequestListener(listener: CommitDetailRequestListener): void {
    this.detailRequestListener = listener;
  }

  async listRepos(organizationId: string, hostId: string): Promise<Repo[]> {
    const host = await this.hosts.get(organizationId, hostId);
    return this.repos.find({ where: { hostId: host.id }, order: { name: "ASC" } });
  }

  /** Unscoped: the agent path has a host id from a token, not a session. */
  async listReposForHost(hostId: string): Promise<Repo[]> {
    return this.repos.find({ where: { hostId }, order: { name: "ASC" } });
  }

  /** Shas whose detail this server already stores — the payload of a `detailAck`. */
  async collectedShas(repoId: string): Promise<string[]> {
    const rows = await this.commits.find({
      where: { repoId, hasDetail: true },
      order: { date: "DESC" },
      select: { id: true, sha: true },
    });
    return rows.map((row) => row.sha);
  }

  /**
   * The window, in the order the agent collected it.
   *
   * ⚠ ORDERED BY `seq`, NEVER BY `date`. The lane algorithm's contract
   * (`packages/core/src/commit-graph.ts`) is that the list arrives newest-first in
   * git's own order: a commit takes the lane its child reserved, and takes a NEW
   * lane only when nothing is waiting for it. Feed it a parent before its child and
   * that parent is, correctly and indistinguishably, a branch tip. `date` is the
   * AUTHOR date and cannot reconstruct `--date-order` (the COMMITTER order the
   * agent walked): the two disagree after any rebase/amend/cherry-pick, which is
   * how a 60-commit, 0-merge history rendered as three lanes.
   *
   * `NULLS LAST` and `take: repo.limit` together keep the cut ON the window
   * boundary: rows with no window position (pre-column rows, history a `truncated`
   * window no longer reaches) sort behind every placed row, so the slice is the
   * window's prefix and never a mixture that drops real window rows for stale ones.
   *
   * AND THEN `stableTopoOrder`, because `date DESC` is not an order at all when the
   * dates tie. A repo that stops being reported keeps its rows forever with `seq` NULL,
   * so the fallback becomes the WHOLE ordering, and two commits sharing one second come
   * back however the database felt like returning them. That is not hypothetical: a
   * 54-commit, 0-merge history here drew as two lanes because `1a0aad8` preceded its
   * own child `1d5a67e`. `seq` is still the authority — the pass is a no-op whenever it
   * is present, and it can only move a row that was already in an impossible place.
   */
  async graph(organizationId: string, hostId: string, repoId: string): Promise<RepoGraph> {
    const repo = await this.getRepo(organizationId, hostId, repoId);
    const [refs, rows] = await Promise.all([
      this.refs.find({ where: { repoId: repo.id }, order: { kind: "ASC", name: "ASC" } }),
      this.commits.find({
        where: { repoId: repo.id },
        order: { seq: { direction: "ASC", nulls: "LAST" }, date: "DESC" },
        take: repo.limit,
      }),
    ]);
    const commits = stableTopoOrder(rows);
    return {
      repo,
      refs,
      commits: commits.map((commit) => ({
        sha: commit.sha,
        parents: commit.parents,
        refs: commit.refs,
        author: commit.author,
        date: commit.date ? commit.date.toISOString() : null,
        subject: commit.subject,
        hasDetail: commit.hasDetail,
      })),
    };
  }

  async commitDetail(
    organizationId: string,
    hostId: string,
    repoId: string,
    sha: string,
  ): Promise<DetailResponse<CommitDetail>> {
    if (!isValidSha(sha)) throw new AppException("GIT_INVALID_SHA", "Invalid commit sha", 400);
    const repo = await this.getRepo(organizationId, hostId, repoId);
    const commit = await this.commits.findOne({ where: { repoId: repo.id, sha } });
    if (!commit) throw new AppException("GIT_COMMIT_NOT_FOUND", "Commit not in the collected window", 404);
    if (!commit.hasDetail) return this.notCollected(repo, sha);
    const detail = await this.details.getCommitDetail(repo.hostId, repo.id, sha);
    if (!detail) {
      // Flag set but object gone (bucket wiped, retention on the storage side).
      // The honest answer is "not collected" — and the flag has to be corrected
      // to match, because ingest reads it as "already stored" and would drop the
      // very copy the request below asks for, leaving the commit unopenable for
      // good. This is not rewriting history: a sha's patch is immutable, and this
      // one is gone.
      await this.commits.update({ repoId: repo.id, sha }, { hasDetail: false });
      return this.notCollected(repo, sha);
    }
    return { available: true, detail, pending: repo.pendingDetails };
  }

  async workingDiff(
    organizationId: string,
    hostId: string,
    repoId: string,
  ): Promise<DetailResponse<WorkingDiff>> {
    const repo = await this.getRepo(organizationId, hostId, repoId);
    if (!repo.hasWorkingDiff) return { available: false, detail: null, pending: 0 };
    const diff = await this.details.getWorkingDiff(repo.hostId, repo.id);
    if (!diff) return { available: false, detail: null, pending: 0 };
    return { available: true, detail: diff, pending: 0 };
  }

  /**
   * A miss — and the request that turns it into a hit.
   *
   * WHY ASK AT ALL: a per-pass detail budget means the collector reaches this
   * commit in its own time, which on a busy repository is several passes away.
   * The contract has a `commitDetail` frame and the agent answers it with a
   * partial snapshot precisely so one click does not have to wait for that.
   *
   * WHY THE ANSWER IS STILL "not available": the agent replies on the WebSocket,
   * asynchronously, and the patch lands through the ordinary ingest path. Holding
   * this GET open for a round trip would put an unreachable host's timeout in
   * front of a click.
   *
   * WHY `pending` IS RAISED TO AT LEAST 1: the UI reads `pending: 0` as "missing —
   * this will never appear" and `pending > 0` as "collecting (N left)". Once we
   * have asked for it, "missing" is a lie; one outstanding request IS one commit
   * still being collected. When nobody was asked (host offline), the repo's own
   * count travels unchanged and "missing" stays the truthful answer.
   */
  private notCollected(repo: Repo, sha: string): DetailResponse<CommitDetail> {
    const outstanding = this.askAgent(repo, { kind: "detail", sha });
    return {
      available: false,
      detail: null,
      pending: outstanding ? Math.max(repo.pendingDetails, 1) : repo.pendingDetails,
    };
  }

  /** ⚠ Never throws: a socket that died mid-write must not turn a read into a 500. */
  private askAgent(repo: Repo, request: AgentGitRequest): boolean {
    try {
      return this.detailRequestListener(repo.hostId, repo.path, request);
    } catch (error) {
      this.logger.warn(
        `${request.kind} request failed host=${repo.hostId} repo=${repo.path}: ${String(error)}`,
      );
      return false;
    }
  }

  /**
   * The paths that existed at a commit.
   *
   * Same three-step shape as `commitDetail`: a hit answers, a miss asks the agent
   * and says "collecting" so the screen can say something true, and the answer
   * arrives through the ordinary ingest path. `pending` is 1 or 0 here rather than
   * a repo-wide count — there is exactly one tree per commit, so "how many trees
   * are outstanding" is the same question as "is this one".
   */
  async commitTree(
    organizationId: string,
    hostId: string,
    repoId: string,
    sha: string,
  ): Promise<DetailResponse<GitTree>> {
    if (!isValidSha(sha)) throw new AppException("GIT_INVALID_SHA", "Invalid commit sha", 400);
    const repo = await this.getRepo(organizationId, hostId, repoId);
    const commit = await this.commits.findOne({ where: { repoId: repo.id, sha } });
    if (!commit) throw new AppException("GIT_COMMIT_NOT_FOUND", "Commit not in the collected window", 404);
    const tree = await this.details.getFileTree(repo.hostId, repo.id, sha);
    if (tree) return { available: true, detail: tree, pending: 0 };
    return { available: false, detail: null, pending: this.askAgent(repo, { kind: "tree", sha }) ? 1 : 0 };
  }

  /**
   * One file's contents at a commit.
   *
   * ⚠ READ FROM A BUFFER, NOT FROM STORAGE, and a miss is normal rather than an
   * error — `git-blob-buffer.service.ts` explains why contents never reach the
   * object store. A second read after the browser dropped its own copy simply
   * costs one more `git show`.
   */
  async commitBlob(
    organizationId: string,
    hostId: string,
    repoId: string,
    sha: string,
    path: string,
  ): Promise<DetailResponse<GitBlob>> {
    if (!isValidSha(sha)) throw new AppException("GIT_INVALID_SHA", "Invalid commit sha", 400);
    if (path.length === 0 || path.length > 1024) {
      throw new AppException("GIT_INVALID_PATH", "Invalid file path", 400);
    }
    const repo = await this.getRepo(organizationId, hostId, repoId);
    const commit = await this.commits.findOne({ where: { repoId: repo.id, sha } });
    if (!commit) throw new AppException("GIT_COMMIT_NOT_FOUND", "Commit not in the collected window", 404);
    const blob = this.blobs.take(repo.id, sha, path);
    if (blob) return { available: true, detail: blob, pending: 0 };
    return {
      available: false,
      detail: null,
      pending: this.askAgent(repo, { kind: "blob", sha, path }) ? 1 : 0,
    };
  }

  private async getRepo(organizationId: string, hostId: string, repoId: string): Promise<Repo> {
    const host = await this.hosts.get(organizationId, hostId);
    const repo = await this.repos.findOne({ where: { id: repoId, hostId: host.id } });
    if (!repo) throw new AppException("REPO_NOT_FOUND", "Repository not found", 404);
    return repo;
  }
}

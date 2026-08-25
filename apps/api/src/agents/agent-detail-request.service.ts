import { ProductLogger } from "../logging/product-logger";
import type { AgentDownstream } from "@pdmux/protocol";
import type { AgentGitRequest } from "../git/git.service";
import { GitService } from "../git/git.service";
import { AgentRegistryService } from "./agent-registry.service";

/**
 * Fetches a commit patch on demand: the click asks, the agent produces, the
 * answer arrives through the ordinary ingest path.
 *
 * WHY THIS EXISTS: the contract has a `commitDetail` frame and the agent answers
 * it with a `partial: true` snapshot — details only, no graph rebuild — but
 * nothing on the server ever sent one. A commit whose patch a pass had not
 * produced yet therefore could not be opened at all: the browser could only wait
 * for some later pass to happen to include it, and the per-pass detail budget
 * (120) makes "later" several passes away on a busy repository.
 *
 * WHY THE ANSWER IS NOT AWAITED: the reply is a WebSocket frame, not a response.
 * Blocking the GET on it would put an unreachable host's timeout in front of a
 * click; the read answers "collecting" now and the next read finds the patch.
 *
 * ⚠ ONE CLICK MUST NOT BECOME A FLOOD. A browser that polls a missing detail
 * calls this on every poll, and every call would otherwise be another `git show`
 * on someone's machine. Three rules keep it to roughly one request per commit:
 *
 *  1. COALESCE — the same (host, repo, sha) is asked once while an answer is
 *     outstanding. This is the rule that matters: without it, polling is a
 *     multiplier.
 *  2. EXPIRE — an outstanding marker is forgotten after {@link DETAIL_REQUEST_TTL_MS},
 *     so a dropped frame (or an agent that could not produce the patch) is
 *     retryable instead of being blocked forever by a request nobody answered.
 *  3. CEILING — at most {@link DETAIL_REQUEST_CAP} requests in flight per host, so
 *     a script sweeping a 300-commit window cannot queue 300 `git show` runs.
 *
 * WHY ARRIVAL DOES NOT CLEAR THE MARKER: it looks tempting (the ingest service
 * sees the partial frame) and it is a trap. An agent that cannot produce the
 * patch — the sha is not in that checkout, the repo moved — answers with a frame
 * carrying no detail for it, so clearing on arrival would let the very next poll
 * ask again, i.e. exactly one request per poll for the one case where the answer
 * is never coming. Letting the TTL do it costs a stored patch nothing: the next
 * read is a hit and never reaches this service.
 */
export class AgentDetailRequestService {
  private readonly logger = new ProductLogger(AgentDetailRequestService.name);
  /** key -> epoch ms after which the request is considered lost. */
  private readonly outstanding = new Map<string, number>();

  constructor(
    private readonly git: GitService,
    private readonly registry: AgentRegistryService,
  ) {}

  /**
   * Register from this side, so `GitModule` never has to know the agents module
   * exists. Same seam as `AgentConfigPushService`: `AgentsModule` already imports
   * `GitModule`, so the dependency only runs one way and no `forwardRef` is needed.
   */
  connect(): void {
    this.git.setDetailRequestListener((hostId, repoPath, request) =>
      this.request(hostId, repoPath, request),
    );
    // An agent that went away (or was replaced) will never answer what it was
    // asked, and the new process knows nothing about it. Dropping the markers lets
    // the next click ask a reconnected agent immediately instead of waiting out a
    // TTL that is now measuring nothing.
    this.registry.onHostDisconnect((hostId) => this.forgetHost(hostId));
  }

  /**
   * Ask for one commit's patch. Returns whether a request for it is outstanding
   * after this call — a fresh one, or one already waiting for an answer.
   *
   * `now` is a parameter (not a `Date.now()` call inside) for the same reason
   * `VerifyDialBudget.allow` takes one: expiry is behaviour worth asserting, and a
   * spec should not have to sleep for 30 seconds to assert it.
   */
  request(
    hostId: string,
    repoPath: string,
    request: AgentGitRequest,
    now: number = Date.now(),
  ): boolean {
    this.expire(now);
    const key = outstandingKey(hostId, repoPath, request);
    if (this.outstanding.has(key)) return true;
    // Nothing is queued for an absent agent: the frame would have no reader, and
    // the collector's next pass covers this commit anyway.
    if (!this.registry.isConnected(hostId)) return false;
    if (this.countForHost(hostId) >= DETAIL_REQUEST_CAP) {
      // `debug`, not `warn`: the caller is a poll, so a warning here would repeat at
      // the polling rate — the ceiling doing its job would look like an incident.
      this.logger.debug(`Detail requests at the ceiling host=${hostId} repo=${repoPath}`);
      return false;
    }
    // One sha per frame — a click asks for one commit — which is trivially within
    // the contract's cap of DETAIL_REQUEST_CAP shas per `commitDetail`.
    //
    // ⚠ AN AGENT TOO OLD TO KNOW `fileTree` / `fileContent` LOGS AND KEEPS THE
    // SOCKET (`DecodeDownstream` in the agent's protocol package says so in as
    // many words), so sending one is safe. It simply never answers, the TTL
    // expires, and the screen says the host's agent cannot do this yet.
    if (!this.registry.sendToHost(hostId, frameFor(repoPath, request))) return false;
    this.outstanding.set(key, now + DETAIL_REQUEST_TTL_MS);
    return true;
  }

  /** Requests in flight right now — the number the ceiling is measured against. */
  outstandingCount(): number {
    return this.outstanding.size;
  }

  private forgetHost(hostId: string): void {
    const prefix = `${hostId}${KEY_SEPARATOR}`;
    for (const key of this.outstanding.keys()) {
      if (key.startsWith(prefix)) this.outstanding.delete(key);
    }
  }

  /**
   * Prunes every host, not just the one being asked about: that keeps the map
   * bounded by what is genuinely in flight rather than by every commit anyone has
   * ever clicked.
   */
  private expire(now: number): void {
    for (const [key, expiresAt] of this.outstanding) {
      if (expiresAt <= now) this.outstanding.delete(key);
    }
  }

  private countForHost(hostId: string): number {
    const prefix = `${hostId}${KEY_SEPARATOR}`;
    let count = 0;
    for (const key of this.outstanding.keys()) {
      if (key.startsWith(prefix)) count += 1;
    }
    return count;
  }
}

/**
 * How long an unanswered request blocks a repeat.
 *
 * The agent answers a `commitDetail` with one `git show` and a frame, so a live
 * one comes back in well under a second. This is sized for the other case — a
 * frame lost to a reconnect — where the cost of being wrong is a click that stays
 * "collecting" for one window, and being too short means a polling browser gets a
 * new `git show` every window.
 */
export const DETAIL_REQUEST_TTL_MS = 30_000;

/**
 * The contract caps `commitDetail.shas` at 50. We send one sha per frame, so the
 * same number does duty as the per-host ceiling on requests in flight: never more
 * outstanding work than one legal frame's worth.
 */
export const DETAIL_REQUEST_CAP = 50;

/** NUL cannot appear in a host id, a path or a sha, so the key cannot collide. */
const KEY_SEPARATOR = "\u0000";

function outstandingKey(hostId: string, repoPath: string, request: AgentGitRequest): string {
  // The kind and the path are part of the identity: a tree and a patch for the
  // same sha are two different questions, and two files in one tree are two more.
  const suffix = request.kind === "blob" ? `${KEY_SEPARATOR}${request.path}` : "";
  return `${hostId}${KEY_SEPARATOR}${repoPath}${KEY_SEPARATOR}${request.kind}${KEY_SEPARATOR}${request.sha}${suffix}`;
}

function frameFor(repoPath: string, request: AgentGitRequest): AgentDownstream {
  if (request.kind === "tree") return { type: "fileTree", repoPath, sha: request.sha };
  if (request.kind === "blob") {
    return { type: "fileContent", repoPath, sha: request.sha, path: request.path };
  }
  return { type: "commitDetail", repoPath, shas: [request.sha] };
}

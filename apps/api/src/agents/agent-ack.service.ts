import { Injectable, Logger } from "@nestjs/common";
import type { AgentDownstream } from "@pdmux/protocol";
import { GitService } from "../git/git.service";
import { AgentRegistryService } from "./agent-registry.service";

/**
 * Tells an agent which commit details this server already stores (`detailAck`).
 *
 * WHY IT MATTERS: a detail is immutable per sha, so an agent that knows what the
 * server holds never rebuilds it. Without the ack, a restarted agent spends its
 * entire per-pass budget (120 patches) re-producing patches the server already
 * has — finite and self-healing, but it delays the commits nobody has yet by
 * several passes on every restart.
 */
@Injectable()
export class AgentAckService {
  private readonly logger = new Logger(AgentAckService.name);

  constructor(
    private readonly git: GitService,
    private readonly registry: AgentRegistryService,
  ) {}

  /** Ack every known repo of a host. Used right after `welcome` and before a `collect`. */
  async ackAllRepos(hostId: string): Promise<number> {
    const repos = await this.git.listReposForHost(hostId);
    let frames = 0;
    for (const repo of repos) frames += await this.ackRepo(hostId, repo.id, repo.path);
    return frames;
  }

  /** Ack the repos named by paths (what an ingest pass just stored details for). */
  async ackRepoPaths(hostId: string, paths: string[]): Promise<number> {
    if (paths.length === 0) return 0;
    const wanted = new Set(paths);
    const repos = await this.git.listReposForHost(hostId);
    let frames = 0;
    for (const repo of repos) {
      if (!wanted.has(repo.path)) continue;
      frames += await this.ackRepo(hostId, repo.id, repo.path);
    }
    return frames;
  }

  private async ackRepo(hostId: string, repoId: string, repoPath: string): Promise<number> {
    if (!this.registry.isConnected(hostId)) return 0;
    const shas = await this.git.collectedShas(repoId);
    if (shas.length === 0) return 0;
    let frames = 0;
    for (const chunk of chunkShas(shas, ACK_CHUNK)) {
      const frame: AgentDownstream = { type: "detailAck", repoPath, shas: chunk };
      if (!this.registry.sendToHost(hostId, frame)) {
        // The agent went away mid-ack; the rest is pointless and the next connect
        // re-acks from scratch anyway.
        this.logger.debug(`Ack aborted, agent gone host=${hostId} repo=${repoPath}`);
        break;
      }
      frames += 1;
    }
    return frames;
  }
}

/** The contract caps a `detailAck` at 1000 shas, and a full window is ~4,500. */
export const ACK_CHUNK = 1000;

export function chunkShas(shas: string[], size: number = ACK_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < shas.length; index += size) {
    chunks.push(shas.slice(index, index + size));
  }
  return chunks;
}

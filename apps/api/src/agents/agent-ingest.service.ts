import { Injectable, Logger } from "@nestjs/common";
import { agentUpstreamSchema, safeParse, type AgentUpstream } from "@pdmux/protocol";
import { EventsService } from "../events/events.service";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { GitIngestService } from "../git/git-ingest.service";
import { HostsService } from "../hosts/hosts.service";
import { MetricsService } from "../metrics/metrics.service";
import { AgentAckService } from "./agent-ack.service";
import { AgentExecService } from "./agent-exec.service";
import { AgentFilesService, type FsAnswer } from "./agent-files.service";
import { AgentRegistryService } from "./agent-registry.service";

export type IngestOutcome =
  | { ok: true; type: AgentUpstream["type"]; sampled?: boolean }
  | { ok: false; error: string };

/**
 * Applies one agent frame. Deliberately socket-free so the whole upstream path
 * (validation, persistence, SSE fan-out) is unit-testable without a network.
 *
 * NOTHING HERE THROWS ON BAD INPUT. Every frame arrives from another machine, and
 * a malformed one must cost that frame — not the connection, and not the pass.
 */
@Injectable()
export class AgentIngestService {
  private readonly logger = new Logger(AgentIngestService.name);

  constructor(
    private readonly hosts: HostsService,
    private readonly metrics: MetricsService,
    private readonly git: GitIngestService,
    private readonly settings: FleetSettingsService,
    private readonly events: EventsService,
    private readonly registry: AgentRegistryService,
    private readonly ack: AgentAckService,
    private readonly exec: AgentExecService,
    private readonly files: AgentFilesService,
  ) {}

  /**
   * ⚠ THE SCOPE IS NOT A PARAMETER, ON PURPOSE. It used to be: the gateway read
   * `host.organizationId` at the WebSocket upgrade and handed the same string to
   * every frame for the life of the socket — days, for a healthy agent. Nothing
   * can move a host between organizations today, so that was latent rather than
   * live, but "latent" here means "correct until someone adds an endpoint", and
   * the frame that would then be misfiled is a metric sample, which is quiet.
   * Reading it from the row at the moment it is needed removes the question
   * instead of guarding it. See the heartbeat branch for what it costs (nothing
   * this path was not already paying).
   */
  async handle(hostId: string, raw: unknown): Promise<IngestOutcome> {
    const parsed = safeParse(agentUpstreamSchema, raw);
    if (!parsed.ok) {
      this.logger.warn(`Invalid agent frame host=${hostId}: ${parsed.error}`);
      return { ok: false, error: parsed.error };
    }
    const frame = parsed.data;
    switch (frame.type) {
      case "hello":
        await this.hosts.applyHello(hostId, frame.hello);
        this.events.publish({ type: "host.hello", hostId, agentVersion: frame.hello.agentVersion });
        return { ok: true, type: "hello" };

      case "heartbeat": {
        // The one branch that needs the scope — `metricStepSec` decides whether
        // this beat becomes a stored sample — so the row is read here and nowhere
        // else. It is the cheap half of a step that already queries this scope's
        // settings rows: a primary-key lookup next to a `find`, on a path that runs
        // once per heartbeat interval per host.
        //
        // Reading BEFORE the write also makes a beat for a host that no longer
        // exists honest. It used to update zero rows and report success; now it is
        // dropped and said out loud. That window is small (deleting a host closes
        // its socket) but it is exactly the window this frame arrives in.
        const host = await this.hosts.getById(hostId);
        if (!host) {
          this.logger.warn(`Heartbeat for a host that no longer exists host=${hostId}`);
          return { ok: false, error: "unknown host" };
        }
        await this.hosts.applyHeartbeat(hostId, frame.heartbeat);
        const { metricStepSec } = await this.settings.resolve(host.organizationId);
        const sample = await this.metrics.recordHeartbeat(hostId, frame.heartbeat, metricStepSec);
        // The card reads this stream: publishing the heartbeat itself (not a
        // "something changed" ping) means the dashboard never has to poll back.
        this.events.publish({
          type: "host.heartbeat",
          hostId,
          ts: frame.heartbeat.ts,
          resource: frame.heartbeat.resource,
          sessions: frame.heartbeat.sessions,
          usage: frame.heartbeat.usage,
          services: frame.heartbeat.services,
        });
        return { ok: true, type: "heartbeat", sampled: sample !== null };
      }

      case "repos": {
        const summary = await this.git.ingest(hostId, frame.repos);
        await this.hosts.touch(hostId);
        // Ack right after storing: the agent's ledger is what stops it rebuilding
        // these same patches after its next restart.
        await this.ack.ackRepoPaths(hostId, summary.repoPathsWithNewDetails);
        this.events.publish({ type: "host.repos", hostId, ...summary });
        return { ok: true, type: "repos" };
      }

      case "terminal":
        // Relayed, never stored: terminal output is a stream, and the browser side
        // that consumes it is wired separately.
        this.registry.emitTerminalFrame(hostId, frame.frame);
        return { ok: true, type: "terminal" };

      case "pong":
        await this.hosts.touch(hostId);
        return { ok: true, type: "pong" };

      case "updateStatus":
        // Progress and outcome share one shape, so the newest frame simply
        // replaces the stored one — the phase says which it is. Every outcome
        // arrives from an agent that is connected (the new binary reports `done`,
        // the restored one reports `rolledBack`), which is why nothing here has to
        // infer failure from a silence.
        await this.hosts.applyUpdateStatus(hostId, frame.update);
        this.events.publish({ type: "host.update", hostId, update: frame.update });
        return { ok: true, type: "updateStatus" };

      case "execResult":
        // Nothing is stored: a command's output belongs to the caller that is
        // blocked on it, not to the host's row. The service settles that promise.
        this.exec.settle(frame.result);
        return { ok: true, type: "execResult" };

      case "fsDir":
      case "fsFile":
      case "fsChunk":
      case "fsWrote":
      case "fsRemoved":
        // Nothing is stored, for the reason the service records: a directory is
        // true for an instant, so the answer belongs to the request waiting on it
        // rather than to the host's row. A byte slice is the same — it is one
        // answer to one question a response stream is blocked on.
        this.files.settle(fsAnswerOf(frame));
        return { ok: true, type: frame.type };

      default:
        return { ok: false, error: "unsupported frame" };
    }
  }
}

/**
 * The payload of a file answer, whatever kind it is.
 *
 * ⚠ EVERY BRANCH IS NAMED, and the union is what makes that safe: adding a sixth
 * answer frame to the contract stops compiling here rather than silently landing
 * in the `default` above, where the request waiting on it would only time out.
 */
function fsAnswerOf(frame: Extract<AgentUpstream, { type: "fsDir" | "fsFile" | "fsChunk" | "fsWrote" | "fsRemoved" }>): FsAnswer {
  switch (frame.type) {
    case "fsDir":
      return frame.dir;
    case "fsFile":
      return frame.file;
    case "fsChunk":
      return frame.chunk;
    case "fsWrote":
      return frame.wrote;
    case "fsRemoved":
      return frame.removed;
  }
}

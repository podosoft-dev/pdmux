import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { agentUpdateSchema, safeParse } from "@pdmux/protocol";
import { AppException } from "../common/app-exception";
import { HostsService } from "../hosts/hosts.service";
import { AgentRegistryService } from "./agent-registry.service";
import { AgentReleaseService } from "./agent-release.service";

/** What the caller gets back for one host: enough to follow the job. */
export interface AgentUpdateCommand {
  hostId: string;
  label: string;
  /** Idempotency key the agent echoes in every `updateStatus`. */
  commandId: string;
  version: string;
  artifactPath: string;
  sha256: string;
  bytes: number;
  os: string;
  arch: string;
}

export interface FleetUpdateFailure {
  hostId: string;
  code: string;
  message: string;
}

export interface FleetUpdateResult {
  version: string;
  requested: number;
  started: AgentUpdateCommand[];
  failed: FleetUpdateFailure[];
  /** Hosts the batch never reached, in request order. */
  notAttempted: string[];
  stopped: boolean;
  /** One sentence for a toast — the same words the audit log records. */
  summary: string;
}

/**
 * At most this many `update` frames are in flight at once.
 *
 * Not a server-load limit — sending a frame is nothing. It is a BLAST-RADIUS
 * limit: each accepted frame ends with that host replacing its binary and exiting,
 * and three at a time means a bad build is caught while most of the fleet is still
 * untouched. It also keeps the failure report readable, because failures arrive
 * one small group at a time instead of all at once.
 */
export const MAX_IN_FLIGHT = 3;

/**
 * Two refusals cancel the rest of the batch.
 *
 * One failure is a host (offline, no build for its platform). Two is a pattern,
 * and continuing through ten more machines to learn the same thing is how a bad
 * release becomes a fleet-wide outage. The remaining hosts are reported as "not
 * attempted" rather than "failed" — the operator must be able to tell what was
 * touched from what was not.
 *
 * ⚠ THE STOP IS NOT RETROACTIVE. The other two workers may already be mid-attempt
 * when the second failure lands, so a batch can report up to
 * `MAX_FAILURES + MAX_IN_FLIGHT - 1` failures. Pretending otherwise would mean
 * hiding a frame that was really sent, which is worse than a count that is bigger
 * than the threshold by design.
 */
export const MAX_FAILURES = 2;

/**
 * Sending an agent a new build of itself.
 *
 * ⚠ THIS SERVICE NEVER PUTS A URL IN A FRAME. `artifactPath` is a path, which the
 * agent joins onto the origin in its own 0600 config — the one it authenticated
 * to. An absolute URL would turn one frame into "every host in the fleet fetches
 * arbitrary bytes from an arbitrary origin", which is a new capability (SSRF),
 * not a convenience. The contract refuses it (`agentUpdateSchema`), and every
 * frame here goes through that parse before it is sent, so a bug in this file is
 * rejected at the boundary instead of reaching a host.
 *
 * ⚠ THERE IS DELIBERATELY NO FLEET ROLLBACK. Each agent rolls ITSELF back when a
 * candidate cannot connect — that is the only mechanism that works, because a host
 * running a broken build is exactly the host the server cannot reach. A "roll the
 * fleet back" button would be a promise the server cannot keep; the operator's
 * move after a bad release is to publish a fixed build and stop offering the bad
 * one.
 */
@Injectable()
export class AgentUpdateService {
  private readonly logger = new Logger(AgentUpdateService.name);

  constructor(
    private readonly hosts: HostsService,
    private readonly registry: AgentRegistryService,
    private readonly releases: AgentReleaseService,
  ) {}

  /**
   * Send one host the build for ITS platform.
   *
   * The version is resolved per host, never per batch: a fleet with Macs and
   * Linux boxes has one release and several binaries, and sending the wrong one
   * would be refused by the agent (`ARCH_MISMATCH`) after a pointless download.
   */
  async updateHost(
    organizationId: string,
    hostId: string,
    options: { version?: string | null; force?: boolean } = {},
  ): Promise<AgentUpdateCommand> {
    const host = await this.hosts.get(organizationId, hostId);
    if (!this.registry.isConnected(host.id)) {
      throw new AppException("HOST_OFFLINE", "No agent is connected to this host", 409);
    }

    const lookup = this.releases.resolve(host.os, host.arch, options.version ?? null);
    if (!lookup.artifact) {
      throw new AppException("AGENT_RELEASE_UNAVAILABLE", lookup.reason, 409);
    }

    // Parse rather than cast. This is the boundary that refuses an absolute URL,
    // a protocol-relative path or a malformed digest — on the server, once, rather
    // than on every agent that receives it. `probationSec` is left out so the
    // contract's own default applies; a second copy of that number here is a value
    // two files could disagree about.
    const parsed = safeParse(agentUpdateSchema, {
      commandId: randomUUID(),
      version: lookup.version,
      artifactPath: lookup.artifact.path,
      sha256: lookup.artifact.sha256,
      bytes: lookup.artifact.bytes,
      // The ARTIFACT's platform, not the host row's: the agent compares these
      // against its own runtime values, and the row may hold the previous agent's
      // spelling of the same machine (`x64` for `amd64`).
      os: lookup.artifact.os,
      arch: lookup.artifact.arch,
      force: options.force ?? false,
    });
    if (!parsed.ok) {
      this.logger.error(`Refusing to send a malformed update frame host=${host.id}: ${parsed.error}`);
      throw new AppException(
        "AGENT_RELEASE_INVALID",
        `The published release is not usable: ${parsed.error}`,
        409,
      );
    }

    if (!this.registry.sendToHost(host.id, { type: "update", update: parsed.data })) {
      // The socket went away between the check above and here.
      throw new AppException("HOST_OFFLINE", "No agent is connected to this host", 409);
    }
    this.logger.log(`Sent update host=${host.id} version=${parsed.data.version} command=${parsed.data.commandId}`);
    return {
      hostId: host.id,
      label: host.label,
      commandId: parsed.data.commandId,
      version: parsed.data.version,
      artifactPath: parsed.data.artifactPath,
      sha256: parsed.data.sha256,
      bytes: parsed.data.bytes,
      os: parsed.data.os,
      arch: parsed.data.arch,
    };
  }

  /**
   * Send a batch, bounded and abortable.
   *
   * The canary precondition comes first and refuses the whole call: a fleet-wide
   * push of a build nobody has run yet is the one action here with no natural
   * limit on the damage, and "update one host, then the rest" is a rule the server
   * can enforce for the cost of a COUNT.
   */
  async updateFleet(
    organizationId: string,
    input: { hostIds: string[]; version: string },
  ): Promise<FleetUpdateResult> {
    // Duplicates would be counted twice and updated twice; the second frame is a
    // different commandId, so the agent would treat it as a second job.
    const hostIds = [...new Set(input.hostIds)];
    const version = input.version;

    const canaries = await this.hosts.countAtAgentVersion(organizationId, version);
    if (canaries === 0) {
      throw new AppException(
        "NO_CANARY",
        `No host is running pdmux-agent ${version} yet. Update a single host first, ` +
          `then roll it out to the rest.`,
        409,
      );
    }

    const started: AgentUpdateCommand[] = [];
    const failed: FleetUpdateFailure[] = [];
    let cursor = 0;

    // A worker claims an index only while the batch is still allowed to run, so
    // "cancelled" can never mean "claimed but silently dropped": every id is
    // either started, failed, or reported as not attempted.
    const worker = async (): Promise<void> => {
      for (;;) {
        if (failed.length >= MAX_FAILURES) return;
        const hostId = hostIds[cursor];
        if (hostId === undefined) return;
        cursor += 1;
        try {
          started.push(await this.updateHost(organizationId, hostId, { version }));
        } catch (error) {
          failed.push(toFailure(hostId, error));
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(MAX_IN_FLIGHT, hostIds.length) }, () => worker()),
    );

    const touched = new Set([...started.map((command) => command.hostId), ...failed.map((f) => f.hostId)]);
    const notAttempted = hostIds.filter((hostId) => !touched.has(hostId));
    const stopped = failed.length >= MAX_FAILURES && notAttempted.length > 0;
    const summary = stopped
      ? `stopped after ${failed.length} of ${hostIds.length} failed; ${notAttempted.length} not attempted`
      : `started ${started.length} of ${hostIds.length}` +
        (failed.length > 0 ? `; ${failed.length} failed` : "");
    if (stopped) this.logger.warn(`Fleet update ${version}: ${summary}`);
    return { version, requested: hostIds.length, started, failed, notAttempted, stopped, summary };
  }
}

/**
 * One host's refusal, flattened.
 *
 * The stable `code` is what makes a batch report readable — "3 hosts refused:
 * HOST_OFFLINE" — so an unexpected error still gets a code rather than a blank.
 */
function toFailure(hostId: string, error: unknown): FleetUpdateFailure {
  if (error instanceof AppException) {
    return { hostId, code: error.code, message: error.message };
  }
  return { hostId, code: "UPDATE_FAILED", message: error instanceof Error ? error.message : String(error) };
}

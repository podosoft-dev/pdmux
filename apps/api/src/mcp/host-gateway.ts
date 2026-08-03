import type { DestroyPlan, EnrollmentOffer, ExecOutcome, HostSummary, PdmuxHostGateway } from "@pdmux/mcp";

import { AgentEnrollmentsService } from "../agents/agent-enrollments.service";
import { AgentExecService } from "../agents/agent-exec.service";
import { GitService } from "../git/git.service";
import { HostServicesService } from "../hosts/host-services.service";
import { HostsService } from "../hosts/hosts.service";
import { MetricsService } from "../metrics/metrics.service";
import type { McpIdentity } from "./host-mcp-keys.service";

/**
 * The bound host's own view of pdmux, assembled from the same services the
 * dashboard's controllers call.
 *
 * ⚠ THE SCOPE COMES FROM THE KEY AND IS APPLIED ON EVERY CALL. Each method passes
 * `identity.organizationId` into `HostsService.get(scope, id)` (and its siblings),
 * which is the single gate that makes "there is no scope-free read of a host"
 * true. Nothing here takes a host id from the caller — `identity.hostId` is the
 * only one in scope, so there is no parameter to get wrong.
 */
export class ApiHostGateway implements PdmuxHostGateway {
  constructor(
    private readonly identity: McpIdentity,
    private readonly deps: {
      hosts: HostsService;
      hostServices: HostServicesService;
      metrics: MetricsService;
      git: GitService;
      enrollments: AgentEnrollmentsService;
      exec: AgentExecService;
      origin: string;
      /**
       * ⚠ HOST MODE HAD NO AUDIT AT ALL UNTIL 2026-08-03, and one of its tools
       * retires a live enrollment code. "Somebody's key voided the install I was
       * half-way through" was answerable by nothing.
       */
      audit: (entry: { tool: string; metadata?: Record<string, unknown> }) => void;
    },
  ) {}

  private get scope(): string {
    return this.identity.organizationId;
  }

  private get hostId(): string {
    return this.identity.hostId;
  }

  async detail(): Promise<HostSummary> {
    const host = await this.deps.hosts.get(this.scope, this.hostId);
    const row = (await this.deps.hosts.list(this.scope)).find((candidate) => candidate.id === host.id);
    return {
      id: host.id,
      label: host.label,
      address: host.address ?? null,
      agentAddress: host.agentAddress ?? null,
      description: host.description ?? null,
      tags: host.tags ?? [],
      enabled: host.enabled,
      online: row?.online ?? false,
      agentVersion: host.agentVersion ?? null,
      os: host.os ?? null,
      arch: host.arch ?? null,
      capabilities: host.capabilities ?? [],
      lastSeenAt: host.lastSeenAt ? new Date(host.lastSeenAt).toISOString() : null,
    };
  }

  async metrics(windowSec: number): Promise<unknown> {
    // `series` is scope-free, so the scope check has to happen here — the same
    // shape the metrics controller uses.
    await this.deps.hosts.get(this.scope, this.hostId);
    return this.deps.metrics.series(this.hostId, { windowSec, stepSec: 30 });
  }

  async sessions(): Promise<unknown> {
    const row = (await this.deps.hosts.list(this.scope)).find((candidate) => candidate.id === this.hostId);
    return row?.sessions ?? [];
  }

  async services(): Promise<unknown> {
    return this.deps.hostServices.list(this.scope, this.hostId);
  }

  async usage(): Promise<unknown> {
    const row = (await this.deps.hosts.list(this.scope)).find((candidate) => candidate.id === this.hostId);
    return row?.usage ?? [];
  }

  async repos(): Promise<unknown> {
    return this.deps.git.listRepos(this.scope, this.hostId);
  }

  /**
   * ⚠ READ-ONLY, AND A SEPARATE METHOD FROM `enrollment()`. A flagged version of one
   * method could not be shown never to mutate; two methods can, and are.
   */
  async enrollmentPlan(): Promise<DestroyPlan | null> {
    const live = await this.deps.enrollments.current(this.scope, this.hostId);
    if (!live) return null;
    this.deps.audit({ tool: "host_install_command", metadata: { dryRun: true, confirmed: false } });
    return {
      willDestroy: [
        {
          type: "enrollment-code",
          count: 1,
          note: "a live code for this host — minting a new one retires it, so an install somebody is part-way through will fail",
        },
      ],
      reversible: false,
      retryWith: { confirm: true },
    };
  }

  async enrollment(): Promise<EnrollmentOffer> {
    // The tool refuses a read-only key before reaching this; this is the second half
    // of the same rule and the one that survives a refactor — the same pairing `run`
    // already has below.
    if (!this.identity.scopes.includes("write")) {
      throw Object.assign(new Error("This key cannot mint an enrollment code"), { code: "MCP_KEY_READ_ONLY" });
    }
    const minted = await this.deps.enrollments.create(this.scope, this.hostId, null);
    this.deps.audit({ tool: "host_install_command", metadata: { confirmed: true } });
    return {
      code: minted.code,
      expiresAt: minted.expiresAt,
      expiresInSec: minted.expiresInSec,
      // The finished line, so a caller never assembles it from parts and gets the
      // origin or the flag order wrong.
      installCommand: `curl -fsSL ${this.deps.origin}/install.sh | sh -s -- --code ${minted.code}`,
    };
  }

  async run(input: { command: string; args: string[]; cwd?: string; timeoutMs?: number }): Promise<ExecOutcome> {
    // The read-only refusal happens in the tool, before this is reached; this is
    // the second half of the same rule and the one that survives a refactor.
    if (!this.identity.scopes.includes("write")) {
      throw Object.assign(new Error("This key cannot run commands"), { code: "MCP_KEY_READ_ONLY" });
    }
    const result = await this.deps.exec.run(this.scope, this.hostId, input);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
      code: result.code,
      message: result.message,
    };
  }
}

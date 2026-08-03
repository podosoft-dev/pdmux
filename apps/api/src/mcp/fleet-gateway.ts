import type {
  CreateHostInput,
  DestroyPlan,
  ExecOutcome,
  FleetEnrollmentOffer,
  HostBrief,
  HostSummary,
  PdmuxFleetGateway,
  PdmuxTier,
} from "@pdmux/mcp";

import { AgentEnrollmentsService } from "../agents/agent-enrollments.service";
import { AgentExecService } from "../agents/agent-exec.service";
import { AgentUpdateService } from "../agents/agent-update.service";
import { GitService } from "../git/git.service";
import { HostServicesService } from "../hosts/host-services.service";
import { HostsService } from "../hosts/hosts.service";
import { MetricsService } from "../metrics/metrics.service";
import type { McpUserIdentity } from "./user-mcp-keys.service";

/**
 * A whole fleet's view of pdmux, assembled from the same services the dashboard's
 * controllers call.
 *
 * ⚠ THIS FILE IS WHERE THE GUARANTEE MOVED TO. In host mode there was no parameter
 * through which a caller could name another machine; here `hostId` arrives from the
 * caller, and what stops it reaching somebody else's scope is that EVERY method
 * passes `this.scope` into `HostsService.get(scope, id)` (or a sibling that takes
 * the scope) before doing anything. `fleet-gateway.spec.ts` exists to assert that,
 * because `packages/mcp` has no database and cannot.
 *
 * ⚠ A HOST IN ANOTHER SCOPE IS 404, NOT 403. `HostsService.get` already answers that
 * way and it must not be "improved": 403 confirms the id exists, which is a fact the
 * caller was not entitled to.
 *
 * ⚠ NOTHING HERE MINTS A CREDENTIAL, and no tool reaches the routes that do. The
 * enrollment code is the apparent exception and is not one — it is single-use, dies
 * in fifteen minutes, is scoped to one host the caller already controls, and
 * redeems into a credential for A MACHINE. An MCP token redeems into this entire
 * surface. Different objects.
 */
export class ApiFleetGateway implements PdmuxFleetGateway {
  constructor(
    private readonly identity: McpUserIdentity,
    private readonly deps: {
      hosts: HostsService;
      hostServices: HostServicesService;
      metrics: MetricsService;
      git: GitService;
      enrollments: AgentEnrollmentsService;
      exec: AgentExecService;
      updates: AgentUpdateService;
      origin: string;
      scopeLabel: string;
      /** Mutating calls only — see `recordToolAudit` at the call site. */
      audit: (entry: { tool: string; target?: { type: string; id?: string; label?: string }; metadata?: Record<string, unknown> }) => void;
    },
  ) {}

  private get scope(): string {
    return this.identity.organizationId;
  }

  private get tier(): PdmuxTier {
    // ⚠ THE EFFECTIVE TIER, never the stored one. What the person was granted is
    // history; what their authority allows right now is the answer.
    return this.identity.effectiveTier;
  }

  /**
   * The scope gate, named so every call site reads as one.
   *
   * Calling it for its side effect rather than its value is deliberate: a method
   * that does not otherwise need the host row still must not act before the scope
   * has been checked.
   */
  private async assertReachable(hostId: string): Promise<void> {
    await this.deps.hosts.get(this.scope, hostId);
  }

  /**
   * ⚠ A SHORT ROW PER HOST, NOT THE FULL VIEW. `HostView` carries services,
   * heartbeat, usage and the last update per host; returning it for forty machines
   * would spend most of a model's context on data it did not ask for. `host_detail`
   * is there for the full picture of one.
   */
  async listHosts(filter: { onlineOnly?: boolean; tag?: string; query?: string }): Promise<HostBrief[]> {
    const rows = await this.deps.hosts.list(this.scope);
    const query = filter.query?.trim().toLowerCase();
    return rows
      .filter((row) => (filter.onlineOnly ? row.online : true))
      .filter((row) => (filter.tag ? (row.tags ?? []).includes(filter.tag) : true))
      .filter((row) => (query ? row.label.toLowerCase().includes(query) : true))
      .map((row) => ({
        id: row.id,
        label: row.label,
        online: row.online,
        enabled: row.enabled,
        agentVersion: row.agentVersion ?? null,
        agentVersionState: row.agentVersionState ?? null,
        os: row.os ?? null,
        arch: row.arch ?? null,
        tags: row.tags ?? [],
        lastUpdateCode: row.lastUpdate?.code ?? null,
      }));
  }

  async detail(hostId: string): Promise<HostSummary> {
    const host = await this.deps.hosts.get(this.scope, hostId);
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

  async metrics(hostId: string, windowSec: number): Promise<unknown> {
    // `series` is scope-free, so the scope check has to happen here — the same
    // shape the metrics controller uses.
    await this.assertReachable(hostId);
    return this.deps.metrics.series(hostId, { windowSec, stepSec: 30 });
  }

  async sessions(hostId: string): Promise<unknown> {
    await this.assertReachable(hostId);
    const row = (await this.deps.hosts.list(this.scope)).find((candidate) => candidate.id === hostId);
    return row?.sessions ?? [];
  }

  async services(hostId: string): Promise<unknown> {
    return this.deps.hostServices.list(this.scope, hostId);
  }

  async usage(hostId: string): Promise<unknown> {
    await this.assertReachable(hostId);
    const row = (await this.deps.hosts.list(this.scope)).find((candidate) => candidate.id === hostId);
    return row?.usage ?? [];
  }

  async repos(hostId: string): Promise<unknown> {
    return this.deps.git.listRepos(this.scope, hostId);
  }

  async createHost(input: CreateHostInput): Promise<FleetEnrollmentOffer> {
    // One call registers the host AND mints its code — `createWithEnrollment` exists
    // because a row in a table is not a host until a command runs on the machine.
    const created = await this.deps.hosts.createWithEnrollment(
      this.scope,
      { label: input.label ?? "", address: input.address, description: input.description, tags: input.tags },
      this.identity.userId,
    );
    this.deps.audit({ tool: "host_create", target: { type: "host", id: created.id, label: created.label } });
    if (!created.enrollment) {
      // ⚠ NOT A FAILED CREATE. `createWithEnrollment` deliberately swallows a mint
      // failure because "the host is the durable thing"; the caller asks for a code
      // separately rather than treating the host as absent.
      throw Object.assign(
        new Error(
          `Host "${created.label}" was registered but no enrollment code could be minted. Call host_install_command with hostId ${created.id}.`,
        ),
        { code: "ENROLLMENT_UNAVAILABLE" },
      );
    }
    return this.offer(created.id, created.label, created.enrollment);
  }

  async updateHost(hostId: string, patch: CreateHostInput & { enabled?: boolean }): Promise<HostSummary> {
    await this.deps.hosts.update(this.scope, hostId, patch);
    this.deps.audit({ tool: "host_update", target: { type: "host", id: hostId }, metadata: { fields: Object.keys(patch) } });
    return this.detail(hostId);
  }

  async enrollment(hostId: string): Promise<FleetEnrollmentOffer> {
    const host = await this.deps.hosts.get(this.scope, hostId);
    const minted = await this.deps.enrollments.create(this.scope, hostId, this.identity.userId);
    this.deps.audit({ tool: "host_install_command", target: { type: "host", id: hostId, label: host.label } });
    return this.offer(host.id, host.label, minted);
  }

  async enrollmentPlan(hostId: string): Promise<DestroyPlan | null> {
    const live = await this.deps.enrollments.current(this.scope, hostId);
    if (live) {
      this.deps.audit({
        tool: "host_install_command",
        target: { type: "host", id: hostId },
        metadata: { dryRun: true, confirmed: false },
      });
    }
    // Nothing live means nothing is voided, so minting needs no confirmation — which
    // is what keeps a fresh host frictionless.
    if (!live) return null;
    return {
      willDestroy: [
        {
          type: "enrollment-code",
          count: 1,
          note: "a live code for this host — minting a new one retires it, so an install somebody is part-way through will fail",
        },
      ],
      reversible: false,
      retryWith: { hostId, confirm: true },
    };
  }

  async enrollmentStatus(hostId: string): Promise<unknown> {
    return this.deps.enrollments.current(this.scope, hostId);
  }

  async updateAgent(hostId: string, input: { version?: string; force: boolean }): Promise<unknown> {
    const accepted = await this.deps.updates.updateHost(this.scope, hostId, {
      version: input.version ?? null,
      force: input.force,
    });
    this.deps.audit({
      tool: "host_agent_update",
      target: { type: "host", id: hostId },
      metadata: { version: input.version ?? null, force: input.force },
    });
    return {
      ...accepted,
      // ⚠ SAID IN THE RESULT, not only in a skill. Every reader of this API expects
      // "it returned" to mean "it worked"; here it means the frame was accepted.
      note: "Accepted, not finished. The outcome arrives later on the host — poll host_agent_update_status and correlate on commandId.",
    };
  }

  async updateAgentPlan(hostId: string, input: { version?: string }): Promise<DestroyPlan> {
    const host = await this.deps.hosts.get(this.scope, hostId);
    return {
      willDestroy: [
        {
          type: "agent-version",
          label: host.label,
          note: `forces ${host.agentVersion ?? "the running agent"} to be replaced with ${input.version ?? "the newest build"} even if that is not newer — there is no downgrade tool to undo it`,
        },
      ],
      reversible: false,
      retryWith: { hostId, version: input.version, force: true, confirm: true },
    };
  }

  async agentUpdateStatus(hostId: string): Promise<unknown> {
    const host = await this.deps.hosts.get(this.scope, hostId);
    return host.lastUpdate ?? { phase: null, note: "No update has been attempted on this host." };
  }

  async updateFleet(hostIds: string[], version: string): Promise<unknown> {
    const result = await this.deps.updates.updateFleet(this.scope, { hostIds, version });
    this.deps.audit({
      tool: "fleet_agent_update",
      metadata: { dryRun: false, confirmed: true, hosts: hostIds.length, version },
    });
    return result;
  }

  async updateFleetPlan(hostIds: string[], version: string): Promise<DestroyPlan> {
    this.deps.audit({ tool: "fleet_agent_update", metadata: { dryRun: true, confirmed: false, hosts: hostIds.length, version } });
    // Named, not counted: the scope check is what makes the count honest, and a host
    // in another scope must not appear in a list of what is about to change.
    const reachable: string[] = [];
    for (const hostId of hostIds) {
      const host = await this.deps.hosts.get(this.scope, hostId);
      reachable.push(host.label);
    }
    return {
      willDestroy: [
        {
          type: "agent-version",
          count: reachable.length,
          note: `each of ${reachable.join(", ")} replaces its binary and exits. Refused with NO_CANARY unless some host already runs ${version}.`,
        },
      ],
      reversible: false,
      retryWith: { hostIds, version, confirm: true },
    };
  }

  async deleteHostPlan(hostId: string): Promise<DestroyPlan> {
    const host = await this.deps.hosts.get(this.scope, hostId);
    // ⚠ THE DRY RUN IS RECORDED TOO. "Somebody's agent tried to delete a host" is the
    // entry an operator most wants and the one it is most tempting to skip — a plan
    // that leaves no trace makes an abandoned attempt indistinguishable from one that
    // never happened.
    this.deps.audit({
      tool: "host_delete",
      target: { type: "host", id: hostId, label: host.label },
      metadata: { dryRun: true, confirmed: false },
    });
    const row = (await this.deps.hosts.list(this.scope)).find((candidate) => candidate.id === hostId);
    return {
      willDestroy: [
        { type: "host", id: host.id, label: host.label },
        {
          type: "agent-token",
          note: "cascade — the agent on that machine is refused for ever and must be re-enrolled before it reports again",
        },
        { type: "mcp-key", note: "cascade — any coding-CLI key bound to this host stops working" },
        { type: "metric-history", note: "every sample recorded for this host" },
        ...(row?.online
          ? [{ type: "live-connection", note: "an agent is connected RIGHT NOW; it is disconnected once the row is gone" }]
          : []),
      ],
      reversible: false,
      retryWith: { hostId, confirm: true },
    };
  }

  async deleteHost(hostId: string): Promise<{ id: string; label: string }> {
    const removed = await this.deps.hosts.remove(this.scope, hostId);
    this.deps.audit({
      tool: "host_delete",
      target: { type: "host", id: removed.id, label: removed.label },
      // `confirmed` is what separates "a person agreed" from "a token did it". This
      // method is only reachable through the confirmed branch.
      metadata: { dryRun: false, confirmed: true },
    });
    return removed;
  }

  async run(
    hostId: string,
    input: { command: string; args: string[]; cwd?: string; timeoutMs?: number },
  ): Promise<ExecOutcome> {
    // The tier refusal happens in the tool, before this is reached; this is the
    // second half of the same rule and the one that survives a refactor.
    if (this.tier === "read") {
      throw Object.assign(new Error("This token cannot run commands"), { code: "MCP_TIER_INSUFFICIENT" });
    }
    const result = await this.deps.exec.run(this.scope, hostId, input);
    // ⚠ THE ARGUMENTS ARE NOT LOGGED. A command line is the one thing on this surface
    // most likely to carry a secret somebody passed on it, and an audit trail that
    // records secrets is a second place they leak from.
    this.deps.audit({
      tool: "run_command",
      target: { type: "host", id: hostId },
      metadata: { command: input.command, argCount: input.args.length },
    });
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

  private offer(
    hostId: string,
    hostLabel: string,
    minted: { code: string; expiresAt: string; expiresInSec: number },
  ): FleetEnrollmentOffer {
    return {
      hostId,
      hostLabel,
      code: minted.code,
      expiresAt: minted.expiresAt,
      expiresInSec: minted.expiresInSec,
      installCommand: `curl -fsSL ${this.deps.origin}/install.sh | sh -s -- --code ${minted.code}`,
      runOn: {
        where: "the target machine — not the machine you are running on",
        who: "you, from your own shell. pdmux holds no ssh credentials and never connects to a host.",
        ask: "If you cannot already reach that machine, ask the user for the ssh destination, how to authenticate, and whether they want a system install (root) or --user. Do not store what they tell you.",
        safer:
          "Pass the code as PDMUX_CODE in the environment rather than --code: the installer reads it and unsets it, so it never reaches the agent's own environment. It is still visible in `ps` on the remote for the life of the ssh command — the code is single-use and 15 minutes old, which is the mitigation.",
        ifNoRoute:
          "A machine with no route out takes a long-lived agent token instead. That is a dashboard action — see docs/OPERATIONS.md §2-4.",
      },
      verifyWith: {
        tool: "host_detail",
        args: { hostId },
        expect: "online: true",
        withinSec: 30,
      },
    };
  }
}

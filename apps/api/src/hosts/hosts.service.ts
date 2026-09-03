import { ProductLogger } from "../logging/product-logger";
import { DataSource, In, Repository } from "typeorm";
import type { AgentHello, Heartbeat, UpdateStatus } from "@pdmux/protocol";
import { AgentReleaseService } from "../agents/agent-release.service";
import { AppException } from "../common/app-exception";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { CreateHostDto } from "./dto/create-host.dto";
import { UpdateHostDto } from "./dto/update-host.dto";
import { Host } from "./host.entity";
import { HostGitRoot } from "./host-git-root.entity";
import { HostService } from "./host-service.entity";
import { resolveGitRoots } from "./git-roots";
import { orderAssignments, toHostView, type HostView } from "./host-view";
import { ServiceExposure } from "../integrations/service-exposure.entity";

/** Set by the gateway so the sidebar can distinguish "beat recently" from
 *  "socket is attached right now" without the hosts module importing it. */
export type ConnectedProbe = (hostId: string) => boolean;

/**
 * Notified after a host's `enabled` flag is written.
 *
 * WHY: the gateway only checks `enabled` at the WebSocket upgrade, so disabling a
 * host used to refuse its *next* connection while the live one kept heartbeating —
 * an operator who parked a machine reasonably believes it stopped. The agents side
 * subscribes and hangs up on the socket.
 *
 * Registered from that side at startup, the same seam `setConnectedProbe` and
 * `setEnrollmentIssuer` use: `AgentsModule` already imports this module, so the
 * dependency runs one way and no `forwardRef` is needed.
 */
export type HostEnabledChangeListener = (hostId: string, enabled: boolean) => Promise<void> | void;

/**
 * Notified after a host row is deleted.
 *
 * WHY IT IS SEPARATE FROM THE ENABLED LISTENER: deleting is not "disabled, but
 * more so". The disabled host keeps its tokens, so the agent is refused and comes
 * back on a toggle; the deleted host takes its tokens with it (`onDelete:
 * CASCADE`), so the same agent is refused forever. A subscriber has to be able to
 * say which of those happened — to the socket it closes, and in the log line.
 *
 * Same registration seam and the same one-way dependency as the listener above.
 */
export type HostRemovedListener = (hostId: string) => Promise<void> | void;
export type HostRemovingListener = (hostId: string, organizationId: string) => Promise<void> | void;
export type HostMovingListener = (hostId: string, organizationId: string) => Promise<void> | void;

/**
 * The one render of an enrollment code, handed over with the host it belongs to.
 *
 * Deliberately narrower than the enrollment view: a caller of `POST /hosts` needs
 * the secret, its identity and its deadline, and nothing else about the row.
 */
export interface IssuedEnrollment {
  id: string;
  /** Plaintext, in this one response body and nowhere else — never re-readable. */
  code: string;
  expiresAt: string;
  /** Floored at 0 by the issuer, so a UI countdown never starts negative. */
  expiresInSec: number;
}

/** Mints the code a freshly registered host is handed. Set once at startup by the
 *  enrollments service — the same late binding `setConnectedProbe` uses, and for
 *  the same reason: that service already depends on this one, so importing it here
 *  would be a circular provider. */
export type EnrollmentIssuer = (
  organizationId: string,
  hostId: string,
  createdByUserId: string | null,
) => Promise<IssuedEnrollment>;

/**
 * What `POST /hosts` answers.
 *
 * Additive on purpose: every field a caller read before is still where it was, and
 * `enrollment` is the thing that turns "register a host" and "get its install code"
 * into one operator action instead of two requests.
 */
export interface CreatedHost extends Host {
  /** `null` when minting failed — see `issueEnrollment`. */
  enrollment: IssuedEnrollment | null;
}

export class HostsService {
  private readonly logger = new ProductLogger(HostsService.name);
  private connectedProbe: ConnectedProbe = () => false;
  private enrollmentIssuer: EnrollmentIssuer | null = null;
  private enabledChangeListener: HostEnabledChangeListener = () => {};
  private removedListener: HostRemovedListener = () => {};
  private removingListener: HostRemovingListener = () => {};
  private movingListener: HostMovingListener = () => {};

  constructor(
    private readonly hosts: Repository<Host>,
    private readonly services: Repository<HostService>,
    // ⚠ THE REPOSITORY, NOT `HostGitRootsService` — that service depends on this
    // one (it resolves a host before touching its rows), so injecting it here
    // would close a provider cycle. The rule that turns rows into paths is a pure
    // function in `git-roots.ts` for the same reason.
    private readonly gitRoots: Repository<HostGitRoot>,
    private readonly settings: FleetSettingsService,
    private readonly releases: AgentReleaseService,
    private readonly dataSource: DataSource,
    private readonly exposures?: Repository<ServiceExposure>,
  ) {}

  /** Called once by the agent gateway at startup (avoids a circular provider). */
  setConnectedProbe(probe: ConnectedProbe): void {
    this.connectedProbe = probe;
  }

  /** Called once by the enrollments service at startup (same reason). */
  setEnrollmentIssuer(issuer: EnrollmentIssuer): void {
    this.enrollmentIssuer = issuer;
  }

  /** Called once by the agent disconnect service at startup (same reason). */
  setEnabledChangeListener(listener: HostEnabledChangeListener): void {
    this.enabledChangeListener = listener;
  }

  /** Called once by the agent disconnect service at startup (same reason). */
  setRemovedListener(listener: HostRemovedListener): void {
    this.removedListener = listener;
  }

  /** External provider cleanup runs before the irreversible database cascade. */
  setRemovingListener(listener: HostRemovingListener): void {
    this.removingListener = listener;
  }

  /** Provider-owned resources are scope-bound and cannot silently follow a row. */
  setMovingListener(listener: HostMovingListener): void {
    this.movingListener = listener;
  }

  /**
   * One request paints the sidebar: rows + services + the latest heartbeat's
   * probe results, already joined and ordered.
   */
  async list(organizationId: string): Promise<HostView[]> {
    const hosts = await this.hosts.find({
      where: { organizationId },
      order: { sortOrder: "ASC", label: "ASC" },
    });
    if (hosts.length === 0) return [];
    const services = await this.services.find({
      where: { hostId: In(hosts.map((h) => h.id)) },
      order: { sortOrder: "ASC" },
    });
    const byHost = new Map<string, HostService[]>();
    for (const service of services) {
      const list = byHost.get(service.hostId) ?? [];
      list.push(service);
      byHost.set(service.hostId, list);
    }
    const roots = await this.gitRoots.find({ where: { hostId: In(hosts.map((h) => h.id)) } });
    const rootsByHost = new Map<string, HostGitRoot[]>();
    for (const root of roots) {
      rootsByHost.set(root.hostId, [...(rootsByHost.get(root.hostId) ?? []), root]);
    }
    const settings = await this.settings.resolve(organizationId);
    const exposureRows = this.exposures
      ? await this.exposures.find({ where: { hostId: In(hosts.map((host) => host.id)), provider: "cloudflare" } })
      : [];
    const exposuresByHost = new Map<string, ServiceExposure[]>();
    for (const exposure of exposureRows) {
      exposuresByHost.set(exposure.hostId, [...(exposuresByHost.get(exposure.hostId) ?? []), exposure]);
    }
    const { heartbeatSec } = settings;
    const now = Date.now();
    return hosts.map((host) =>
      toHostView(host, byHost.get(host.id) ?? [], {
        gitRootCount: resolveGitRoots(settings, rootsByHost.get(host.id) ?? []).length,
        heartbeatSec,
        now,
        connected: this.connectedProbe(host.id),
        latestAgentVersion: this.releases.latestFor(host.os, host.arch),
        exposures: exposuresByHost.get(host.id) ?? [],
      }),
    );
  }

  async getView(organizationId: string, id: string): Promise<HostView> {
    const host = await this.get(organizationId, id);
    const services = await this.services.find({ where: { hostId: host.id }, order: { sortOrder: "ASC" } });
    const roots = await this.gitRoots.find({ where: { hostId: host.id } });
    const settings = await this.settings.resolve(organizationId);
    const exposures = this.exposures
      ? await this.exposures.find({ where: { hostId: host.id, provider: "cloudflare" } })
      : [];
    return toHostView(host, services, {
      gitRootCount: resolveGitRoots(settings, roots).length,
      heartbeatSec: settings.heartbeatSec,
      now: Date.now(),
      connected: this.connectedProbe(host.id),
      latestAgentVersion: this.releases.latestFor(host.os, host.arch),
      exposures,
    });
  }

  /**
   * How many hosts in this scope are already running a given build.
   *
   * This is the canary precondition for a fleet-wide update, and the row is
   * better evidence than it looks: `agentVersion` is written by `applyHello`,
   * which only runs on a connection the agent completed. A host that swapped to a
   * broken build never gets that far (it rolls itself back and reports the old
   * version), so a non-zero count means some machine ran this exact build and
   * came back.
   */
  async countAtAgentVersion(organizationId: string, agentVersion: string): Promise<number> {
    return this.hosts.count({ where: { organizationId, agentVersion } });
  }

  /**
   * Just the ids in a scope — one row-shaped read, no services, no heartbeat, no
   * release lookup.
   *
   * A fan-out (config push after a settings change) needs "who is in this scope",
   * not a card to draw, and `list()` would build a HostView per host to answer it.
   */
  async listIds(organizationId: string): Promise<string[]> {
    const rows = await this.hosts.find({ where: { organizationId }, select: { id: true } });
    return rows.map((row) => row.id);
  }

  /** Scoped read. Every caller goes through this — there is no unscoped `findOne`
   *  on the request path, which is what keeps org A out of org B's rows. */
  async get(organizationId: string, id: string): Promise<Host> {
    const host = await this.hosts.findOne({ where: { id, organizationId } });
    if (!host) throw new AppException("HOST_NOT_FOUND", "Host not found", 404);
    return host;
  }

  /** Unscoped lookup for the agent gateway, which authenticates by token, not session. */
  async getById(id: string): Promise<Host | null> {
    return this.hosts.findOne({ where: { id } });
  }

  async create(organizationId: string, dto: CreateHostDto): Promise<Host> {
    await this.assertLabelFree(organizationId, dto.label, null);
    const sortOrder = dto.sortOrder ?? (await this.nextSortOrder(organizationId));
    const host = this.hosts.create({
      organizationId,
      label: dto.label,
      address: dto.address ?? null,
      description: dto.description ?? null,
      tags: dto.tags ?? [],
      sortOrder,
      enabled: dto.enabled ?? true,
      capabilities: [],
      connectorCapabilities: { cloudflared: false },
    });
    return this.hosts.save(host);
  }

  /**
   * Register a host AND hand over the code that turns it into a machine.
   *
   * WHY THEY ARE ONE CALL: a row in a table is not a host. The step that makes it
   * one is a command run on the box, and that command needs a code — so an
   * operator who registered a host had to make a second request before they had
   * anything to copy. One action, one thing to paste.
   */
  async createWithEnrollment(
    organizationId: string,
    dto: CreateHostDto,
    createdByUserId: string | null,
  ): Promise<CreatedHost> {
    const host = await this.create(organizationId, dto);
    return { ...host, enrollment: await this.issueEnrollment(organizationId, host.id, createdByUserId) };
  }

  /**
   * Mint a code for a host that already exists, and never let that mint undo it.
   *
   * THE HOST IS THE DURABLE THING. A code lives 15 minutes and is one click away
   * from being replaced, so a failed mint answers with the host and a null code —
   * rethrowing would turn a registration the operator completed into a 5xx and
   * (worse, if it were ever wrapped in a transaction) throw the row away for the
   * sake of a secret that is regenerated by a button already on their screen.
   */
  private async issueEnrollment(
    organizationId: string,
    hostId: string,
    createdByUserId: string | null,
  ): Promise<IssuedEnrollment | null> {
    const issuer = this.enrollmentIssuer;
    if (!issuer) {
      this.logger.warn(`Register host ${hostId} without an enrollment code: no issuer is wired`);
      return null;
    }
    try {
      return await issuer(organizationId, hostId, createdByUserId);
    } catch (error) {
      this.logger.warn(`Register host ${hostId} without an enrollment code: ${String(error)}`);
      return null;
    }
  }

  async update(organizationId: string, id: string, dto: UpdateHostDto): Promise<Host> {
    const host = await this.get(organizationId, id);
    if (dto.label !== undefined && dto.label !== host.label) {
      await this.assertLabelFree(organizationId, dto.label, host.id);
      host.label = dto.label;
    }
    if (dto.address !== undefined) host.address = dto.address ?? null;
    if (dto.description !== undefined) host.description = dto.description ?? null;
    if (dto.tags !== undefined) host.tags = dto.tags;
    if (dto.sortOrder !== undefined) host.sortOrder = dto.sortOrder;
    if (dto.enabled !== undefined) host.enabled = dto.enabled;
    const saved = await this.hosts.save(host);
    // `PATCH /hosts/:id {enabled:false}` is the toggle most operators actually use,
    // so it has to enforce the flag exactly like the dedicated endpoint below.
    if (dto.enabled !== undefined) await this.notifyEnabledChanged(saved.id, saved.enabled);
    return saved;
  }

  /**
   * Delete the row, then hang up on the agent that was reporting into it.
   *
   * WHY THE DELETE GOES FIRST: it is the thing the operator asked for, and it is
   * the thing that can still fail. Closing first would drop a live agent for a host
   * that a failing delete leaves standing — a disconnect nobody asked for, on a
   * machine that is still in the fleet. Deleting first means the socket is only
   * closed once there is nothing left for it to report into.
   *
   * The other direction has no such cost: the row is already gone when the listener
   * runs, so a `close()` that throws is logged and swallowed (see `notifyRemoved`),
   * and the registry evicts before it closes — a socket that refuses to die is
   * still off the card and can no longer be written to.
   */
  async remove(organizationId: string, id: string): Promise<{ id: string; label: string }> {
    const host = await this.get(organizationId, id);
    await this.removingListener(host.id, organizationId);
    await this.hosts.delete({ id: host.id });
    await this.notifyRemoved(host.id);
    return { id: host.id, label: host.label };
  }

  async setEnabled(organizationId: string, id: string, enabled: boolean): Promise<Host> {
    const host = await this.get(organizationId, id);
    host.enabled = enabled;
    const saved = await this.hosts.save(host);
    await this.notifyEnabledChanged(saved.id, saved.enabled);
    return saved;
  }

  /**
   * Fired on every write of the flag, not only on a transition.
   *
   * Re-disabling an already-disabled host that somehow has a socket attached should
   * still hang up on it — an operator pressing the toggle again is asking for the
   * state to be true, not for a diff to be applied.
   *
   * ⚠ THE ROW IS ALREADY SAVED. Same contract as the fleet-settings and
   * host-services listeners: a subscriber that throws is logged and swallowed,
   * because a socket's problems must not turn a completed write into a 5xx.
   */
  private async notifyEnabledChanged(hostId: string, enabled: boolean): Promise<void> {
    try {
      await this.enabledChangeListener(hostId, enabled);
    } catch (error) {
      this.logger.warn(`Enforcing enabled=${enabled} on the live agent failed host=${hostId}: ${String(error)}`);
    }
  }

  /**
   * ⚠ THE ROW IS ALREADY GONE — and unlike the enabled flag, it cannot be put back
   * by pressing the toggle again. A subscriber that throws must therefore never
   * turn a completed delete into a 5xx the operator reads as "it is still there".
   */
  private async notifyRemoved(hostId: string): Promise<void> {
    try {
      await this.removedListener(hostId);
    } catch (error) {
      this.logger.warn(`Disconnecting the agent of a deleted host failed host=${hostId}: ${String(error)}`);
    }
  }

  async reorder(organizationId: string, ids: string[]): Promise<HostView[]> {
    const rows = await this.hosts.find({ where: { organizationId }, select: { id: true } });
    const { assignments, missing } = orderAssignments(ids, new Set(rows.map((r) => r.id)));
    if (missing.length > 0) throw new AppException("HOST_NOT_FOUND", "Host not found", 404);
    for (const assignment of assignments) {
      await this.hosts.update({ id: assignment.id, organizationId }, { sortOrder: assignment.sortOrder });
    }
    return this.list(organizationId);
  }

  // --- agent-driven updates (no session; the gateway authenticated the token) ---

  async applyHello(hostId: string, hello: AgentHello): Promise<void> {
    await this.hosts.update(
      { id: hostId },
      {
        agentVersion: hello.agentVersion,
        // Recorded because the version state treats a wire-contract mismatch as
        // `incompatible`, and only the agent knows which contract it speaks.
        agentProtocolVersion: hello.protocolVersion,
        os: hello.os,
        arch: hello.arch,
        capabilities: hello.capabilities,
        connectorCapabilities: hello.connectors,
        // Empty is what an agent built before this field sends, and it is also a real
        // answer from one that found no routable interface. Either way it is not an
        // address, so it is stored as the absence rather than as "".
        agentAddress: hello.address.trim() || null,
        lastSeenAt: new Date(),
      },
    );
  }

  /**
   * Newest update progress/outcome for a host.
   *
   * `lastSeenAt` moves with it: the frame arrived on a live socket, so the agent
   * is demonstrably here — the same reason `pong` touches it.
   */
  async applyUpdateStatus(hostId: string, update: UpdateStatus): Promise<void> {
    await this.hosts.update({ id: hostId }, { lastUpdate: update, lastSeenAt: new Date() });
  }

  async applyHeartbeat(hostId: string, heartbeat: Heartbeat): Promise<void> {
    await this.hosts.update(
      { id: hostId },
      // The agent's clock decides `ts`, but lastSeenAt is the server's: a host with
      // a skewed clock would otherwise look permanently offline (or never stale).
      { lastHeartbeat: heartbeat, lastSeenAt: new Date() },
    );
  }

  async touch(hostId: string): Promise<void> {
    await this.hosts.update({ id: hostId }, { lastSeenAt: new Date() });
  }

  /**
   * Move a host to another person's scope.
   *
   * WHY MOVING RATHER THAN SHARING: registration happens under whichever account
   * the person was signed in as, so a machine routinely lands in the wrong one —
   * and the answer to that is to correct the owner, not to invent a per-host
   * access list. Sharing is the expensive shape here
   * (`metricStepSec` is applied when the sample is WRITTEN, so there is exactly
   * one stream per host and no per-viewer answer to give).
   *
   * Tokens, services, repositories and samples all hang off `hostId`, so they
   * follow the row; the credential stays valid and the socket is deliberately
   * left open. Provider-owned external resources are the exception: a registered
   * moving listener refuses the move until those resources are removed. The scope is re-read
   * where it is used rather than captured on the socket, so the next heartbeat lands in the
   * new scope's settings.
   */
  async move(organizationId: string, id: string, targetEmail: string): Promise<Host> {
    const host = await this.get(organizationId, id);
    await this.movingListener(host.id, organizationId);
    const target = await this.resolveUserScope(targetEmail);
    if (target === organizationId) {
      throw new AppException("HOST_ALREADY_IN_SCOPE", "This host is already in that account", 409);
    }
    // ⚠ BEFORE THE WRITE. The unique index would reject the update anyway, but a
    // constraint violation surfaces as a 500 and says nothing a person can act on;
    // this answers with the same 409 that creating a duplicate label does.
    // No exception id: in the destination scope this row is a newcomer, so any
    // row already holding the label is a genuine clash.
    await this.assertLabelFree(target, host.label, null);
    await this.hosts.update(
      { id: host.id, organizationId },
      { organizationId: target, sortOrder: await this.nextSortOrder(target) },
    );
    return this.get(target, host.id);
  }

  /**
   * An email address to the scope that account's own hosts live in.
   *
   * Read straight from better-auth's table because that is where users are — this
   * module owns no user entity, and a SELECT is the whole of it. The address is
   * lower-cased for the lookup: better-auth stores it as typed, and "the account I
   * mean" is not case-sensitive to the person typing it.
   */
  private async resolveUserScope(email: string): Promise<string> {
    const rows: { id: string }[] = await this.dataSource.query(
      'SELECT id FROM "user" WHERE lower(email) = lower($1) LIMIT 1',
      [email.trim()],
    );
    const found = rows[0];
    if (!found) throw new AppException("USER_NOT_FOUND", "No account with that email", 404);
    return `personal:${found.id}`;
  }

  private async nextSortOrder(organizationId: string): Promise<number> {
    const last = await this.hosts.findOne({
      where: { organizationId },
      order: { sortOrder: "DESC" },
      select: { id: true, sortOrder: true },
    });
    return last ? last.sortOrder + 1 : 0;
  }

  private async assertLabelFree(organizationId: string, label: string, exceptId: string | null): Promise<void> {
    const existing = await this.hosts.findOne({ where: { organizationId, label }, select: { id: true } });
    if (existing && existing.id !== exceptId) {
      throw new AppException("HOST_LABEL_TAKEN", `A host named "${label}" already exists`, 409);
    }
  }
}

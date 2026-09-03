import {
  PROTOCOL_VERSION,
  agentVersionState,
  type AgentDiagnostic,
  type AgentUsage,
  type AgentVersionState,
  type Heartbeat,
  type Listener,
  type MuxSession,
  type UpdateStatus,
} from "@pdmux/protocol";
import type { Host } from "./host.entity";
import type { HostService, ProbeKind } from "./host-service.entity";
import type { ServiceExposure } from "../integrations/service-exposure.entity";

/**
 * Shapes the sidebar reads. Kept as pure functions over rows + the stored
 * heartbeat so "what the card shows" is testable without a database or a socket.
 */

export type ProbeStatus = "up" | "down" | "unknown";

export interface HostServiceView {
  id: string;
  label: string;
  port: number;
  probe: ProbeKind;
  path: string;
  urlTemplate: string | null;
  sortOrder: number;
  /** Off keeps the row but stops the probe and hides it from the launcher. */
  enabled: boolean;
  status: ProbeStatus;
  latencyMs: number | null;
  /** Active public hostname, if this service is routed through a managed provider. */
  exposure: {
    id: string;
    provider: "cloudflare";
    url: string;
    mode: "access" | "public";
    status: "pending" | "protected" | "public" | "error";
  } | null;
}

export interface HostView {
  id: string;
  label: string;
  address: string | null;
  /**
   * Where the host says it can be reached, from its own `hello` — `null` until an
   * agent new enough to report it has connected.
   *
   * ⚠ The operator's `address` still wins wherever they have set one. This is the
   * answer for a host nobody has described yet, and it is the only one available:
   * a server sees the far end of a socket, and the agent dials out.
   */
  agentAddress: string | null;
  description: string | null;
  tags: string[];
  sortOrder: number;
  enabled: boolean;
  agentVersion: string | null;
  /** Newest published build FOR THIS HOST's os/arch — not "the newest release". */
  latestAgentVersion: string | null;
  /** current / outdated / ahead / unknown / incompatible. Advisory, never a gate. */
  agentVersionState: AgentVersionState;
  /** Progress or outcome of the last remote update, straight from the agent. */
  lastUpdate: UpdateStatus | null;
  os: string | null;
  arch: string | null;
  capabilities: string[];
  connectorCapabilities: { cloudflared: boolean };
  lastSeenAt: string | null;
  online: boolean;
  connected: boolean;
  resource: Heartbeat["resource"] | null;
  sessions: MuxSession[];
  usage: AgentUsage[];
  /** Degraded capabilities the agent reported (git missing, PTY fallback, …).
   *  Carried to the card on purpose: in `doctor` output on the host, nobody sees
   *  them until they already suspect a problem. */
  diagnostics: AgentDiagnostic[];
  services: HostServiceView[];
  /**
   * How many directories this host's agent is actually told to scan for git
   * checkouts — its own rows if it has any, the fleet list otherwise.
   *
   * ⚠ IT IS THE EFFECTIVE COUNT, NOT THE ROW COUNT, and it is here so the git
   * dock can stop saying one sentence about three situations. `git.noRepos`
   * reads as "wait a moment", so a host that was never given a path looked,
   * for ever, like a host still working on it. Zero here means
   * nobody has said where to look; the paths themselves stay off this payload.
   */
  gitRootCount: number;
  /**
   * TCP ports the agent found the host listening on — discovered, not registered.
   *
   * ⚠ THREE STATES, AND THE UI MUST RENDER THEM AS THREE. `null` is an agent too
   * old to report ports at all; `[]` is an agent that looked and found none; a
   * list is what it found. The middle and the first looked identical for a while
   * — the contract used to default the absence to `[]` during parsing — and the
   * dashboard told a host's owner "nothing is listening here" about a host that
   * had never been asked.
   *
   * A fourth case hides inside `[]`: an agent that has no way to enumerate ports
   * on its platform. That one is separated by its `listeners.unavailable`
   * diagnostic, not by this field.
   */
  listeners: Listener[] | null;
}

/**
 * A host is "online" when its last heartbeat is recent enough. Being liberal here
 * (3 missed beats) matters: a card that flickers offline on one slow beat trains
 * people to ignore the state entirely.
 */
export function isOnline(lastSeenAt: Date | null, heartbeatSec: number, now: number): boolean {
  if (!lastSeenAt) return false;
  return now - lastSeenAt.getTime() <= Math.max(15, heartbeatSec * 3) * 1000;
}

/**
 * Join each registered service to the probe result the agent reported for it.
 *
 * The agent echoes the server-assigned service id, so this is an id join rather
 * than a port match — two services may legitimately share a port (different paths)
 * and matching on port silently showed one service's state on the other's row.
 */
export function joinServiceProbes(
  services: HostService[],
  heartbeat: Heartbeat | null,
  exposures: ServiceExposure[] = [],
): HostServiceView[] {
  const probes = new Map((heartbeat?.services ?? []).map((p) => [p.id, p]));
  const exposureByService = new Map(exposures.map((exposure) => [exposure.serviceId, exposure]));
  return [...services]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .map((service) => {
      const probe = probes.get(service.id);
      const exposure = exposureByService.get(service.id);
      return {
        id: service.id,
        label: service.label,
        port: service.port,
        probe: service.probe,
        path: service.path,
        urlTemplate: service.urlTemplate,
        sortOrder: service.sortOrder,
        enabled: service.enabled,
        // No probe result is "unknown", never "down": an agent that does not
        // support probing must not paint every service red.
        status: probe?.status ?? "unknown",
        latencyMs: probe?.latencyMs ?? null,
        exposure: exposure ? {
          id: exposure.id,
          provider: "cloudflare",
          url: `https://${exposure.hostname}`,
          mode: exposure.mode,
          status: exposure.status,
        } : null,
      };
    });
}

export function toHostView(
  host: Host,
  services: HostService[],
  options: {
    gitRootCount: number;
    heartbeatSec: number;
    now: number;
    connected: boolean;
    /**
     * Resolved by the caller, which is the only side that can ask the release
     * lookup. Passing the answer rather than the service keeps this file a pure
     * function of rows — and the comparison itself stays in `@pdmux/protocol`, so
     * the API, the browser and the Go agent cannot reach three different verdicts.
     */
    latestAgentVersion: string | null;
    exposures?: ServiceExposure[];
  },
): HostView {
  const heartbeat = host.lastHeartbeat;
  return {
    id: host.id,
    label: host.label,
    address: host.address,
    agentAddress: host.agentAddress ?? null,
    description: host.description,
    tags: host.tags ?? [],
    sortOrder: host.sortOrder,
    enabled: host.enabled,
    agentVersion: host.agentVersion,
    latestAgentVersion: options.latestAgentVersion,
    agentVersionState: agentVersionState({
      agentVersion: host.agentVersion,
      protocolVersion: host.agentProtocolVersion ?? null,
      latest: options.latestAgentVersion,
      protocolVersionSupported: PROTOCOL_VERSION,
    }),
    lastUpdate: host.lastUpdate ?? null,
    os: host.os,
    arch: host.arch,
    capabilities: host.capabilities ?? [],
    connectorCapabilities: { cloudflared: host.connectorCapabilities?.cloudflared === true },
    lastSeenAt: host.lastSeenAt ? host.lastSeenAt.toISOString() : null,
    online: isOnline(host.lastSeenAt, options.heartbeatSec, options.now),
    connected: options.connected,
    resource: heartbeat?.resource ?? null,
    sessions: heartbeat?.sessions ?? [],
    usage: heartbeat?.usage ?? [],
    diagnostics: heartbeat?.diagnostics ?? [],
    services: joinServiceProbes(services, heartbeat, options.exposures),
    gitRootCount: options.gitRootCount,
    // ⚠ `?? null`, NOT `?? []`: the absence is the answer for an older agent.
    listeners: heartbeat?.listeners ?? null,
  };
}

/**
 * Turn a full ordered id list into sortOrder assignments.
 *
 * Ids outside the caller's scope come back as `missing` instead of being written:
 * a reorder is a mutation, and silently accepting a foreign id would confirm that
 * it exists.
 */
export function orderAssignments(
  ids: string[],
  scopeIds: Set<string>,
): { assignments: { id: string; sortOrder: number }[]; missing: string[] } {
  const missing = ids.filter((id) => !scopeIds.has(id));
  const seen = new Set<string>();
  const assignments: { id: string; sortOrder: number }[] = [];
  for (const id of ids) {
    if (missing.includes(id) || seen.has(id)) continue;
    seen.add(id);
    assignments.push({ id, sortOrder: assignments.length });
  }
  return { assignments, missing };
}

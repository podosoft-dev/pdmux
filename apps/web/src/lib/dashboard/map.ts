/**
 * The single place where API JSON becomes what `@pdmux/core` and `@pdmux/ui` read.
 *
 * WHY IT IS ONE FILE AND NOT A DOZEN INLINE EXPRESSIONS: every one of these
 * conversions (ISO date -> epoch seconds, bytes -> "12Gi/30Gi", service row ->
 * launcher option) is a rule that has to be identical everywhere it happens and
 * that is worth a unit test. Scattered through components they would be neither.
 *
 * Everything here is pure and defensive: the payloads come from another machine's
 * collector by way of the API, so a missing field yields a sane value rather than
 * an exception inside a render.
 */
import type {
  AgentRow,
  CardPrefs,
  GridHost,
  HistoryFeed,
  HostSeries,
  MetricsFeed,
  MetricsRow,
  RefInput,
  ServiceInput,
  ServiceOption,
  UncommittedSummary,
} from "@pdmux/core";
import {
  agentRows,
  cardPrefs,
  historySeries,
  sanitizeCardPrefs,
  serviceOptions,
  uncommittedSummary,
} from "@pdmux/core";
import type { HostDetail, HostResources, HostState, HostSummary, HostUpdateMark, PickerHost, RepoHead } from "@pdmux/ui";
import type {
  GraphCommitRow,
  HostServiceView,
  HostView,
  MetricsResponse,
  RepoRefRow,
  RepoRow,
} from "./types";

/** A working-tree patch as the API returns it (protocol `workingDiffSchema`). */
export interface WorkingDiffLike {
  staged?: readonly unknown[];
  unstaged?: readonly unknown[];
  untracked?: readonly unknown[];
}

/**
 * How a card labels reachability.
 *
 * A DISABLED host is `unknown`, not `offline`: nobody is collecting it, so every
 * value on the card is missing by decision rather than by failure, and painting it
 * as "stopped" would send someone looking for a machine that is fine.
 */
export function hostState(host: Pick<HostView, "enabled" | "online">): HostState {
  if (!host.enabled) return "unknown";
  return host.online ? "online" : "offline";
}

/**
 * `update` arrives already composed rather than being derived here, because the
 * sentence needs `fmt()` and the app's catalogue, and this file is the mapping layer
 * rather than the wording one. Absent by default: a card with nothing to say draws
 * no row at all.
 */
export function hostSummary(host: HostView, update: HostUpdateMark | null = null): HostSummary {
  return { id: host.id, name: host.label, state: hostState(host), update };
}

/** Hosts as the terminal grid needs them (label -> name, sessions passed through). */
export function gridHosts(hosts: readonly HostView[]): GridHost[] {
  return hosts.map((host) => ({
    id: host.id,
    name: host.label,
    // A disabled host cannot answer a terminal open, so it is not "online" here
    // even if its last heartbeat is recent.
    online: host.enabled && host.online,
    sessions: host.sessions ?? [],
  }));
}

/**
 * The multiplexer diagnostic code, as the agent emits it.
 *
 * Read from the heartbeat rather than from the hello's capability list because
 * this has to be LIVE: someone who installs a multiplexer expects the picker to
 * offer sessions on the next beat, not after the agent happens to reconnect.
 */
const MUX_MISSING = "mux.missing";

/** The picker takes the same facts; keeping the mapping shared stops them drifting. */
export function pickerHosts(hosts: readonly HostView[]): PickerHost[] {
  // Zipped with gridHosts rather than rebuilt from HostView: `online` there also
  // accounts for a disabled host, and computing it a second time here is how the
  // two drift.
  const grid = gridHosts(hosts);
  return grid.map((host, index) => ({
    ...host,
    // Absence has to be POSITIVELY reported. A host that is offline, or one whose
    // agent is too old to send diagnostics, keeps its session targets — refusing
    // them on missing evidence would break every host that predates the field.
    multiplexer: !(hosts[index]?.diagnostics ?? []).some((d) => d.code === MUX_MISSING),
  }));
}

/**
 * The fast feed, in the shape `freshMetrics()` validates.
 *
 * `ts` is the newest heartbeat we have, NOT the clock: if every agent went quiet
 * ten minutes ago, stamping "now" on their last known percentages would make a dead
 * fleet look live, which is exactly what that staleness check exists to prevent.
 */
export function metricsFeed(hosts: readonly HostView[], fallbackNowMs: number): MetricsFeed {
  let newest = 0;
  const rows: MetricsRow[] = [];
  for (const host of hosts) {
    const seen = host.lastSeenAt ? Date.parse(host.lastSeenAt) : Number.NaN;
    if (Number.isFinite(seen)) newest = Math.max(newest, seen);
    rows.push({
      id: host.id,
      cpuPct: host.resource?.cpuPct ?? null,
      memPct: host.resource?.memPct ?? null,
      diskPct: host.resource?.diskPct ?? null,
      swapPct: host.resource?.swapPct ?? null,
    });
  }
  return { ts: Math.floor((newest || fallbackNowMs) / 1000), hosts: rows };
}

/** One host's metric series in the shape `historySeries()` reads. */
export function historyFeed(metrics: MetricsResponse): HistoryFeed {
  return {
    t: metrics.t ?? [],
    window: metrics.window,
    hosts: [
      {
        id: metrics.hostId,
        cpu: metrics.cpu ?? [],
        mem: metrics.mem ?? [],
        disk: metrics.disk ?? [],
        // `?? []` is load-bearing here and not defensive habit: a server that has not
        // deployed the swap columns yet omits the key entirely, and an empty series
        // draws no line — which is the honest answer — rather than throwing.
        swap: metrics.swap ?? [],
      },
    ],
  };
}

/** Convenience: metrics response -> the series for that host. */
export function hostSeries(metrics: MetricsResponse): HostSeries {
  return historySeries(historyFeed(metrics), metrics.hostId);
}

const UNITS = ["B", "Ki", "Mi", "Gi", "Ti", "Pi"] as const;

/** Binary size with one decimal below 10 — "12Gi", "9.4Gi", "512Mi". */
export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const text = size >= 10 || unit === 0 ? String(Math.round(size)) : size.toFixed(1);
  return `${text}${UNITS[unit]}`;
}

function ratioHint(used: number | null | undefined, total: number | null | undefined): string {
  const usedText = formatBytes(used);
  const totalText = formatBytes(total);
  if (!usedText || !totalText) return "";
  return `${usedText}/${totalText}`;
}

/**
 * The resource readings for a card.
 *
 * `fresh` is the fast feed after `freshMetrics()` has vetted it; when it is null
 * (stale collector) the card falls back to the host row's own heartbeat rather than
 * showing nothing — the row carries the timestamp that made it stale in the first
 * place, so the dash it draws is honest either way.
 */
export function hostResources(host: HostView, fresh: MetricsRow | null | undefined): HostResources {
  const resource = host.resource;
  return {
    cpuPct: fresh?.cpuPct ?? resource?.cpuPct ?? null,
    memPct: fresh?.memPct ?? resource?.memPct ?? null,
    diskPct: fresh?.diskPct ?? resource?.diskPct ?? null,
    swapPct: fresh?.swapPct ?? resource?.swapPct ?? null,
    memHint: ratioHint(resource?.memUsedBytes, resource?.memTotalBytes),
    diskHint: ratioHint(resource?.diskUsedBytes, resource?.diskTotalBytes),
    // ⚠ THIS IS WHY `ratioHint` MUST KEEP TREATING 0 AS A VALUE. `formatBytes(0)` is
    // "0B", which is truthy, so a swapless host gets "0B/0B" — the only thing on the
    // card that separates "nowhere to swap to" from "somewhere, and unused" ("0B/8Gi").
    // Both read 0%. A tidy-up that made `ratioHint` skip zeroes would delete that.
    swapHint: ratioHint(resource?.swapUsedBytes, resource?.swapTotalBytes),
  };
}

/**
 * Addresses that identify no particular machine.
 *
 * Every computer calls itself `127.0.0.1`, so as a way of saying WHICH host a row is,
 * a loopback address carries exactly as much as a blank cell — while looking like it
 * carries something. `0.0.0.0` is a bind address that was never a destination.
 */
const NOWHERE = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?(::1|::ffff:127(\.\d{1,3}){3})\]?)$/i;

/**
 * The address, when it actually distinguishes this host — otherwise `null`.
 *
 * REPORTED: the fleet table's Address column was either empty or `127.0.0.1`, and
 * neither told the reader anything. The blank is honest; the loopback is worse than
 * blank, because it reads as an answer. Every host would give that same answer about
 * itself, which is the definition of a column that is not worth reading.
 *
 * TWO SOURCES, AND THE OPERATOR'S WINS. They typed theirs on purpose and it is what
 * service links are built from, so it is the answer wherever it is a real one. The
 * agent's is the fallback, and it is the only way this can be filled in at all: a
 * server sees the far end of a socket and the agent dials OUT — measured here, one
 * arrives as `127.0.0.1` (same machine) and another as a container-bridge address
 * belonging to the proxy. The host asks its own kernel instead, which is why the
 * answer travels in `hello` rather than being observed.
 *
 * BOTH GO THROUGH THE SAME SIEVE. An agent alone on a machine with nothing but a
 * loopback interface would report `127.0.0.1` in good faith, and it would be as
 * useless coming from there as typed by hand.
 *
 * ⚠ THIS IS FOR DISPLAY, NOT FOR REACHING THE HOST. `serviceUrl` deliberately still
 * uses whatever the operator stored — and ONLY that: a link built from an address
 * nobody chose would be the product guessing where a service lives, which is the very
 * thing `serviceUrl` refuses to do when it declines to fall back to localhost.
 */
export function hostAddress(host: Pick<HostView, "address" | "agentAddress">): string | null {
  return usable(host.address) ?? usable(host.agentAddress);
}

function usable(value: string | null | undefined): string | null {
  const address = (value ?? "").trim();
  if (!address || NOWHERE.test(address)) return null;
  return address;
}

/**
 * The URL that opens one service.
 *
 * A registered template wins (it is the only way to express https, a subdomain or a
 * path-based reverse proxy); otherwise the address plus the port. A host with no
 * address yields an empty string, and the launcher refuses to open it — guessing
 * `localhost` would open the operator's own machine, which is a different computer.
 */
export function serviceUrl(host: Pick<HostView, "address" | "label">, service: HostServiceView): string {
  if (service.exposure?.url && (service.exposure.status === "protected" || service.exposure.status === "public")) {
    return service.exposure.url;
  }
  const address = (host.address ?? "").trim();
  const path = service.path && service.path !== "/" ? service.path : "";
  const template = (service.urlTemplate ?? "").trim();
  if (template) {
    return template
      .replaceAll("{address}", address)
      .replaceAll("{host}", address)
      .replaceAll("{port}", String(service.port))
      .replaceAll("{path}", path);
  }
  if (!address) return "";
  // Only 443 is assumed to be TLS. Guessing https for anything else produces a link
  // that fails a handshake, which reads as "the service is down".
  const scheme = service.port === 443 ? "https" : "http";
  return `${scheme}://${address}:${service.port}${path}`;
}

export function serviceInputs(host: HostView): ServiceInput[] {
  return host.services
    // ⚠ THE OTHER HALF OF WHAT "off" MEANS. Turning a service off stops the probe
    // server-side; without this it would still sit in the card's launcher, one
    // mis-click from opening something the owner deliberately parked — and it
    // would sit there with no status, because nothing is probing it any more.
    .filter((service) => service.enabled !== false)
    .map((service) => ({
      id: service.id,
      label: service.label,
      url: serviceUrl(host, service),
      status: service.status,
    }));
}

export function serviceOptionsFor(host: HostView): ServiceOption[] {
  return serviceOptions(serviceInputs(host));
}

/** Agent budget rows in a fixed provider order so two cards line up. */
export function agentRowsFor(host: HostView, providers: readonly string[], nowMs: number): AgentRow[] {
  return agentRows(host.usage ?? [], providers, nowMs);
}

/** Reference data for the card's settings popover. Empty values are dropped. */
export function hostDetails(
  host: HostView,
  labels: { address: string; agent: string; system: string; lastSeen: string; ssh: string; never: string },
  formatDate: (iso: string) => string,
): HostDetail[] {
  const details: HostDetail[] = [];
  // The displayable address, so the popover does not report `127.0.0.1` as this host's
  // whereabouts — nor hand out `ssh 127.0.0.1`, which connects to whoever ran it.
  const address = hostAddress(host);
  if (address) details.push({ key: "address", label: labels.address, value: address });
  if (host.agentVersion) details.push({ key: "agent", label: labels.agent, value: host.agentVersion });
  const system = [host.os, host.arch].filter(Boolean).join(" · ");
  if (system) details.push({ key: "system", label: labels.system, value: system });
  details.push({
    key: "lastSeen",
    label: labels.lastSeen,
    value: host.lastSeenAt ? formatDate(host.lastSeenAt) : labels.never,
  });
  if (address) details.push({ key: "ssh", label: labels.ssh, value: `ssh ${address}` });
  return details;
}

/** Per-card widget visibility, resolved from the server's stored preferences. */
export function cardPrefsFor(stored: Record<string, unknown> | undefined, hostId: string): CardPrefs {
  return cardPrefs(sanitizeCardPrefs(stored ? { [hostId]: stored } : {}), hostId);
}

/**
 * Graph rows for `GitGraph`: the API sends ISO strings (JSON has no date type) and
 * the graph wants epoch seconds, which is also what its `formatDate` receives.
 */
export function graphCommits(commits: readonly GraphCommitRow[]): {
  sha: string;
  parents: string[];
  refs: string[];
  author: string;
  date: number | null;
  subject: string;
}[] {
  return commits.map((commit) => {
    const parsed = commit.date ? Date.parse(commit.date) : Number.NaN;
    return {
      sha: commit.sha,
      parents: commit.parents ?? [],
      refs: commit.refs ?? [],
      author: commit.author ?? "",
      date: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null,
      subject: commit.subject ?? "",
    };
  });
}

export function refInputs(refs: readonly RepoRefRow[]): RefInput[] {
  return refs.map((ref) => ({
    name: ref.name,
    kind: ref.kind,
    sha: ref.sha,
    ahead: ref.ahead,
    behind: ref.behind,
    gone: ref.gone,
  }));
}

/**
 * Where HEAD is, for the refs panel.
 *
 * The repo row knows the branch, the sha and its own divergence; only the REF row
 * knows the upstream's NAME and whether it is gone. Joining them here (rather than in
 * the panel) is what keeps the component from guessing which ref HEAD follows — and
 * `gone` is the answer people open the panel for, so it must survive the join.
 *
 * A detached HEAD has no branch row to join to, which is exactly why it is reported
 * as detached rather than as an unknown branch.
 */
export function repoHead(repo: RepoRow | null, refs: readonly RepoRefRow[]): RepoHead | null {
  if (!repo) return null;
  const tracking = repo.detached
    ? undefined
    : refs.find((ref) => ref.kind === "local" && ref.name === repo.headBranch);
  return {
    branch: repo.headBranch,
    sha: repo.headSha,
    detached: repo.detached,
    upstream: tracking?.upstream ?? null,
    // The ref row is the fresher of the two for divergence: it is what the collector
    // measured against this branch's own upstream.
    ahead: tracking?.ahead ?? repo.ahead,
    behind: tracking?.behind ?? repo.behind,
    gone: tracking?.gone ?? false,
    path: repo.path,
  };
}

/**
 * The working-tree summary for the pinned first row.
 *
 * The repo row only carries a TOTAL (`dirtyCount`), so before the patch is fetched
 * the kinds are unknown; showing the total under one arbitrary kind would be a
 * guess, so the count travels as `unstaged` only when nothing better exists and the
 * caller labels the row with the total. Once the working diff is loaded the real
 * per-kind counts replace it.
 */
export function uncommittedFor(repo: RepoRow | null, diff: WorkingDiffLike | null): UncommittedSummary | null {
  if (diff) {
    const summary = uncommittedSummary({
      staged: diff.staged?.length ?? 0,
      unstaged: diff.unstaged?.length ?? 0,
      untracked: diff.untracked?.length ?? 0,
    });
    if (summary) return summary;
  }
  if (!repo || repo.dirtyCount <= 0) return null;
  return uncommittedSummary({ unstaged: repo.dirtyCount });
}

/** Every file in a working diff, in the order the row groups them. */
export function workingDiffFiles<T>(diff: {
  staged?: readonly T[];
  unstaged?: readonly T[];
  untracked?: readonly T[];
} | null): T[] {
  if (!diff) return [];
  return [...(diff.staged ?? []), ...(diff.unstaged ?? []), ...(diff.untracked ?? [])];
}

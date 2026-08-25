/**
 * The shapes the dashboard reads from the API.
 *
 * WHY THEY ARE RESTATED HERE: the API's view types live in a server workspace that
 * this app does not (and should not) import — pulling them in would drag entities,
 * database code and server-only dependencies into a browser bundle. What travels between the two is JSON,
 * so JSON is what this file describes. Anything that is a real contract between
 * three programs lives in `@pdmux/protocol` instead and is imported from there.
 */
import type {
  AgentDiagnostic,
  AgentUsage,
  AgentVersionState,
  Listener,
  MuxSession,
  Resource,
  UpdateStatus,
} from "@pdmux/protocol";

export type ProbeKind = "tcp" | "http" | "none";
export type ProbeStatus = "up" | "down" | "unknown";

export interface HostServiceView {
  id: string;
  label: string;
  port: number;
  probe: ProbeKind;
  path: string;
  urlTemplate: string | null;
  sortOrder: number;
  /** Off keeps the row but stops the probe and hides it from the card launcher. */
  enabled: boolean;
  status: ProbeStatus;
  latencyMs: number | null;
}

/** `GET /hosts` — one row per host, already joined to its last heartbeat. */
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
  lastSeenAt: string | null;
  online: boolean;
  connected: boolean;
  resource: Resource | null;
  sessions: MuxSession[];
  usage: AgentUsage[];
  /**
   * What the host cannot do, recomputed every heartbeat.
   *
   * ⚠ THE API HAS SENT THIS SINCE THE CARD WAS WRITTEN AND NOTHING HERE READ IT.
   * So a host with no multiplexer looked exactly like one whose sessions had all
   * exited — "No sessions running" — and the picker went on offering to create
   * one, which the agent then had to refuse.
   */
  diagnostics: AgentDiagnostic[];
  services: HostServiceView[];
  /**
   * How many directories this host's agent is actually told to scan for git
   * checkouts — its own rows if it has any, the fleet list otherwise.
   *
   * ⚠ EFFECTIVE, NOT THE ROW COUNT. It exists so the git dock can stop saying one
   * sentence about three situations: `git.noRepos` reads as "wait a moment", so
   * a host nobody ever gave a path to looked, for ever, like a host still
   * working on it.
   */
  gitRootCount: number;
  /**
   * Ports the agent found the host listening on, before anybody registered them.
   *
   * ⚠ THREE STATES AND THE SCREEN MUST SHOW THREE. `null` is an agent too old to
   * report ports at all — it says nothing rather than "none", and telling its
   * owner "nothing is listening on this host" is a claim nobody made. `[]` is an
   * agent that looked and found none. A list is what it found.
   *
   * A fourth case hides inside `[]`: a host with no way to enumerate ports. Only
   * its `listeners.unavailable` diagnostic separates that one.
   */
  listeners: Listener[] | null;
}

/** `GET /hosts/:id/metrics?window=` — aligned arrays, oldest first. */
export interface MetricsResponse {
  hostId: string;
  t: number[];
  cpu: (number | null)[];
  mem: (number | null)[];
  disk: (number | null)[];
  swap: (number | null)[];
  step: number;
  window: number;
  latest: { ts: string; cpuPct: number | null; memPct: number | null; diskPct: number | null } | null;
}

/**
 * `GET /hosts/:hostId/git-roots` — one directory this host's agent scans.
 *
 * ⚠ IT IS A PATH ON THAT MACHINE, not on the server rendering this. The list
 * used to be fleet-wide, and a fleet-wide list of machine-specific paths is only
 * right while every machine has the same layout.
 */
export interface HostGitRootView {
  id: string;
  hostId: string;
  path: string;
  /** Off stops the scan without losing a path somebody worked out once. */
  enabled: boolean;
  sortOrder: number;
  /**
   * ⚠ READ BY THE CARD, NOT DECORATION. It is what separates "nobody has scanned
   * this yet" from "scanned, found nothing" — the agent's git pass is a timer, so
   * a path saved a moment ago is genuinely unanswered for up to one interval.
   */
  createdAt: string;
}

/** `GET /hosts/:hostId/repos` */
export interface RepoRow {
  id: string;
  hostId: string;
  path: string;
  name: string;
  headBranch: string | null;
  headSha: string | null;
  detached: boolean;
  ahead: number | null;
  behind: number | null;
  dirtyCount: number;
  dirtySubmodules: number;
  truncated: boolean;
  limit: number;
  pendingDetails: number;
  hasWorkingDiff: boolean;
  lastSnapshotAt: string | null;
  error: string | null;
  /**
   * The last remote check, or nulls when nobody has asked for one.
   *
   * ⚠ NOT `RepoRefRow`. Those are LOCAL pointers — including remote-TRACKING refs,
   * which are as old as the last fetch somebody ran by hand. These are what the
   * remote itself answered, and `remoteCheckedAt === null` means never asked, which
   * the screen says out loud rather than drawing as "up to date".
   */
  remoteRefs: { name: string; sha: string; kind: "branch" | "tag" }[] | null;
  remoteCheckedAt: string | null;
  remoteError: string | null;
}

export interface RepoRefRow {
  id: string;
  repoId: string;
  name: string;
  kind: "local" | "remote" | "tag";
  sha: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  gone: boolean;
}

/** A graph row: no body, no patch — those are one click away (see CONTRACTS §C4). */
export interface GraphCommitRow {
  sha: string;
  parents: string[];
  refs: string[];
  author: string;
  /** ISO string on the wire; the graph wants epoch seconds (see `map.ts`). */
  date: string | null;
  subject: string;
  hasDetail: boolean;
}

export interface RepoGraphResponse {
  repo: RepoRow;
  refs: RepoRefRow[];
  commits: GraphCommitRow[];
}

/** "Not collected yet" is an answer, not an error — hence `available`. */
export interface DetailResponse<T> {
  available: boolean;
  detail: T | null;
  pending: number;
}

export interface LayoutView {
  name: string;
  isDefault: boolean;
  payload: Record<string, unknown>;
  updatedAt: string;
}

export interface PrefsView {
  layouts: LayoutView[];
  hostPrefs: Record<string, Record<string, unknown>>;
}

export interface AgentTokenView {
  id: string;
  hostId: string;
  name: string;
  /** ISO, or null for never — the default, and what every real host uses. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MintedAgentToken extends AgentTokenView {
  /** Plaintext, returned exactly once by mint/rotate. Never stored by this app. */
  token: string;
}

export type AgentEnrollmentStatus = "live" | "consumed" | "revoked" | "expired";

/** `GET /hosts/:id/enrollments/current` — state only, never the code. */
export interface AgentEnrollmentView {
  id: string;
  hostId: string;
  status: AgentEnrollmentStatus;
  expiresAt: string;
  /** Floored at 0 by the server, so a countdown never starts negative. */
  expiresInSec: number;
  consumedAt: string | null;
  consumedIp: string | null;
  revokedAt: string | null;
  tokenId: string | null;
  createdAt: string;
}

/**
 * `POST /hosts/:id/enrollments` — the one and only render of the code.
 *
 * Nothing derived from it is stored server-side, so `masked` travels with the mint
 * or not at all: a later read cannot reproduce even the tail of it.
 */
export interface MintedAgentEnrollment extends AgentEnrollmentView {
  code: string;
  masked: string;
}

/**
 * The code `POST /hosts` hands over with the host it just registered.
 *
 * Narrower than a mint's answer on purpose — the secret, its id and its deadline
 * are everything the install dialog needs, and this is still the plaintext's only
 * render.
 */
export interface CreatedHostEnrollment {
  id: string;
  code: string;
  expiresAt: string;
  expiresInSec: number;
}

/**
 * `POST /hosts` — the registered host, plus its first enrollment code.
 *
 * Only the identity fields are declared: the row comes back as it is stored, not
 * as a `HostView` (no probe join, no online verdict — those arrive with the next
 * fleet poll). `enrollment` is `null` when minting failed; the host still exists,
 * and the dialog's Regenerate is the way to get a code.
 */
export interface CreatedHost {
  id: string;
  label: string;
  enrollment: CreatedHostEnrollment | null;
}

/** `POST /hosts/:id/agent/update` — enough to follow the job that was started. */
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

/** `POST /fleet/agent/update` — what was touched, what refused, what was skipped. */
export interface FleetUpdateResult {
  version: string;
  requested: number;
  started: AgentUpdateCommand[];
  failed: FleetUpdateFailure[];
  /** Hosts the batch never reached, in request order. */
  notAttempted: string[];
  stopped: boolean;
  summary: string;
}

/**
 * `GET /fleet/settings` — the WHOLE settings document, as the API returns it.
 *
 * It used to declare only the four fields the dashboard reacted to, which was honest
 * while nothing could change them: a screen that shows every setting has to be typed
 * against every setting, and a narrower view here would have meant the settings page
 * inventing its own shape beside this one.
 *
 * Each field's reasoning — what it costs, why the number is what it is — belongs with
 * the server that enforces it (`apps/api/src/fleet/fleet-settings.ts`) and is not
 * copied here; the settings screen puts that same reasoning on screen through i18n.
 */
export interface FleetSettingsView {
  heartbeatSec: number;
  gitIntervalSec: number;
  gitRoots: string[];
  gitLimit: number;
  gitDetailBudget: number;
  usageProviders: string[];
  usageIntervalSec: number;
  probeTimeoutMs: number;
  statusFileCap: number;
  bodyMaxChars: number;
  terminalBufferBytes: number;
  metricStepSec: number;
  metricRetentionDays: number;
  /**
   * Days a host may stay silent before the server deletes it; `0` = never, which
   * is what a fleet that has not opted in reports.
   *
   * ⚠ STILL OPTIONAL WHILE ITS NEIGHBOURS ARE NOT, and the absence has to read as
   * OFF. An API older than this field answers without it, and a page that cannot
   * confirm the removal was configured must not warn about one — `savedNumber()` in
   * `fleet-settings.ts` is the single place that turns the absence into `0`.
   */
  staleHostRetentionDays?: number;
  /** Whether this fleet accepts fleet-wide MCP tokens. Host-scoped keys are unaffected. */
  mcpUserTokens: boolean;
}

/**
 * `GET /fleet/scope` — which fleet this session is looking at, and whether it may
 * change it.
 *
 * The answer comes from the API because it depends on the active organization, which
 * the SvelteKit loader cannot see. Screens read `canManage`; `personal` is the reason
 * behind it, kept because "you may change this because it is your own" and "you may
 * change this because you are an administrator" are different things to explain.
 */
export interface FleetScopeView {
  personal: boolean;
  canManage: boolean;
}

/**
 * `GET /hosts/:id/mcp-keys` — the credential a coding CLI uses, without the secret.
 *
 * `keyPrefix` is the few leading characters kept in the clear so a row can be
 * named in a list; it is never enough to reconstruct anything. `scopes` is what
 * makes a read-only key refuse `run_command`.
 */
export interface McpKeyView {
  id: string;
  hostId: string;
  label: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** `POST /hosts/:id/mcp-keys` — the one and only render of the plaintext. */
export interface MintedMcpKey extends McpKeyView {
  key: string;
}

/**
 * The credential that reaches a WHOLE FLEET, as `/access` shows it.
 *
 * Separate from `McpKeyView` rather than a widened version of it, for the reason the
 * tables are separate: a host key costs you one machine and this costs you every
 * machine you can see. A shape that could be either would invite a screen that
 * treated them as the same thing.
 */
export interface McpTokenView {
  id: string;
  label: string;
  keyPrefix: string;
  tier: "read" | "operate" | "admin";
  /**
   * What it would get if presented right now, or `null` when its owner has lost the
   * scope. Different from `tier` means the person was demoted after minting it —
   * showing only the granted tier would be a promise the server no longer keeps.
   */
  effectiveTier: "read" | "operate" | "admin" | null;
  expiresAt: string;
  expiringSoon: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** `POST /account/mcp-tokens` — the one and only render of the plaintext. */
export interface MintedMcpToken extends McpTokenView {
  token: string;
}

/**
 * What the screen may offer, answered by the SERVER.
 *
 * The page loader could work the ceiling out from the session, and then there would
 * be two copies of "who may grant what" — the drift showing up as a form offering a
 * tier the API then refuses.
 */
export interface McpTokenPolicy {
  ceiling: "read" | "operate" | "admin";
  tiers: readonly ("read" | "operate" | "admin")[];
  expiryDays: readonly number[];
}

/** One file from a host's disk — the shape `BlobView` already renders. */
export interface FsFileView {
  path: string;
  lines: string[];
  binary: boolean;
  truncated: boolean;
  bytes: number;
  error: string | null;
}

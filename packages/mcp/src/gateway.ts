/**
 * What the tools are allowed to reach, and nothing more.
 *
 * ⚠ WHY THIS IS AN INTERFACE RATHER THAN AN HTTP CLIENT ONTO OUR OWN REST API.
 * The obvious shape — the tools call `/hosts/:id` over loopback, so permissions
 * live in exactly one place — needs those routes to accept this credential. They
 * do not: every fleet route takes a browser session. Teaching them to accept an
 * MCP key as well would open the WHOLE fleet surface to it, including routes that
 * have no business being reachable by a coding CLI, and the blast radius of a
 * leaked key would then be "whatever a controller happens to expose today".
 *
 * So the surface is enumerated instead. Each method below is a deliberate grant,
 * the API implements them by calling the same services the dashboard's own
 * controllers call, and the scope filter those services enforce
 * (`HostsService.get(scope, id)` — there is no scope-free read of a host) is
 * still the single gate. What this file gives up is "one place"; what it buys is
 * that adding a capability is an edit here, visible in review, rather than a side
 * effect of somebody adding a route somewhere else.
 *
 * It is also why `packages/mcp` stays framework-free: a contract test can hand
 * these tools a fake and assert on the surface without a database.
 *
 * ⚠ THAT ARGUMENT IS STRONGER SINCE FLEET TOKENS EXIST, NOT WEAKER. A credential
 * that reaches every host in a scope is exactly the one you would least like to have
 * "whatever a controller happens to expose today" as its blast radius. The
 * enumeration below is what keeps `POST /hosts/:id/move`, the admin routes and every
 * future endpoint out of reach by default.
 */

export interface HostSummary {
  id: string;
  label: string;
  address: string | null;
  agentAddress: string | null;
  description: string | null;
  tags: string[];
  enabled: boolean;
  online: boolean;
  agentVersion: string | null;
  os: string | null;
  arch: string | null;
  capabilities: string[];
  lastSeenAt: string | null;
}

export interface ExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  code: string | null;
  message: string;
}

/** What `POST /hosts/:id/enrollments` already returns, minus what nobody needs. */
export interface EnrollmentOffer {
  code: string;
  expiresAt: string;
  expiresInSec: number;
  /** The finished one-liner, so the caller never assembles it from parts. */
  installCommand: string;
}

/**
 * The bound host's own view of pdmux.
 *
 * Every method acts on the ONE host the presented key belongs to; none of them
 * takes a host id, so there is no parameter through which a caller could name
 * another machine.
 */
export interface PdmuxHostGateway {
  detail(): Promise<HostSummary>;
  metrics(windowSec: number): Promise<unknown>;
  sessions(): Promise<unknown>;
  services(): Promise<unknown>;
  usage(): Promise<unknown>;
  repos(): Promise<unknown>;
  /** Mints a fresh enrollment code, retiring any live one, exactly as the dialog does. */
  enrollment(): Promise<EnrollmentOffer>;
  /** Rejected when the key is read-only, or when the agent cannot run commands. */
  run(input: { command: string; args: string[]; cwd?: string; timeoutMs?: number }): Promise<ExecOutcome>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Fleet mode
 *
 * ⚠ THE INTERFACE ABOVE IS UNCHANGED, AND ITS COMMENT IS STILL TRUE OF IT. A
 * host-bound key still cannot name another machine, because the methods it reaches
 * take no host id. What follows is a SECOND surface for a different credential, not
 * a relaxation of the first.
 *
 * ⚠ AND THAT IS A REAL TRADE, WORTH NAMING. Where host mode had a STRUCTURAL
 * guarantee — no parameter existed through which another machine could be named —
 * fleet mode has a CHECKED one: `hostId` is a parameter, and what stops it reaching
 * somebody else's machine is `HostsService.get(scope, id)` in the implementation.
 * The guarantee moved from the type system to a runtime call, so the test that holds
 * it has to move with it: it lives in the API package beside that call, because this
 * package has no database to check against.
 * ──────────────────────────────────────────────────────────────────────────── */

export type PdmuxTier = "read" | "operate" | "admin";

/** A short row per host. See `listHosts` for why this is not the full view. */
export interface HostBrief {
  id: string;
  label: string;
  online: boolean;
  enabled: boolean;
  agentVersion: string | null;
  /** `current` | `outdated` | `ahead` | `unknown` | `incompatible`, as the server judges it. */
  agentVersionState: string | null;
  os: string | null;
  arch: string | null;
  tags: string[];
  /** The code of the last update attempt, when it ended badly. Null otherwise. */
  lastUpdateCode: string | null;
}

/**
 * Who the caller is, what they can reach, and the rules they must follow.
 *
 * ⚠ BUILT BY THE SERVER, NOT BY THE GATEWAY. Which tools exist at which tier is the
 * tool surface's own knowledge; a gateway that imported that table would be a second
 * place it could drift from, and the API package would need the value at runtime
 * purely to answer a question about this package.
 */
export interface FleetIdentity {
  tier: PdmuxTier;
  /** Display only. Never an id a caller can pass anywhere. */
  scopeLabel: string;
  /** Where install.sh lives, so a caller never assembles an origin. */
  origin: string;
  availableTools: string[];
  /** Named so a model asks for a stronger token rather than inventing a workaround. */
  unavailableTools: { name: string; needsTier: PdmuxTier }[];
  /** Read once. The first entry is the ssh rule, because it decides behaviour. */
  notes: string[];
}

/** One thing a destructive call would destroy. */
export interface DestroyItem {
  type: string;
  id?: string;
  label?: string;
  count?: number;
  note?: string;
}

/**
 * What a destructive tool WOULD do, computed without doing it.
 *
 * ⚠ THE PLAN METHODS ARE SEPARATE AND READ-ONLY, never the mutator behind a flag.
 * That is what lets a recording fake prove "a dry run cannot mutate" — with one
 * method and a boolean there is nothing to assert on, and a later refactor that
 * folds them together would pass every test.
 */
export interface DestroyPlan {
  willDestroy: DestroyItem[];
  reversible: boolean;
  /** Verbatim arguments for the confirmed retry, so the model reconstructs nothing. */
  retryWith: Record<string, unknown>;
}

export interface CreateHostInput {
  label?: string;
  address?: string;
  description?: string;
  tags?: string[];
}

/** `EnrollmentOffer`, plus what the caller has to be told to act on it correctly. */
export interface FleetEnrollmentOffer extends EnrollmentOffer {
  hostId: string;
  hostLabel: string;
  /**
   * ⚠ THE SSH BOUNDARY, DELIVERED AS DATA RATHER THAN ONLY AS PROSE IN A SKILL.
   * pdmux never connects to a host and holds no ssh credentials; the command has to
   * be run BY THE CALLER, on the target. A model that reads this in the result
   * behaves correctly even when the skill was not loaded.
   */
  runOn: {
    where: string;
    who: string;
    ask: string;
    safer: string;
    ifNoRoute: string;
  };
  /** The step callers skip: the installer exits before the first handshake. */
  verifyWith: { tool: string; args: Record<string, unknown>; expect: string; withinSec: number };
}

/**
 * Everything a host-bound gateway can do, but for a NAMED host, plus the operations
 * that only make sense across a fleet.
 */
export interface PdmuxFleetGateway {
  listHosts(filter: { onlineOnly?: boolean; tag?: string; query?: string }): Promise<HostBrief[]>;

  detail(hostId: string): Promise<HostSummary>;
  metrics(hostId: string, windowSec: number): Promise<unknown>;
  sessions(hostId: string): Promise<unknown>;
  services(hostId: string): Promise<unknown>;
  usage(hostId: string): Promise<unknown>;
  repos(hostId: string): Promise<unknown>;

  createHost(input: CreateHostInput): Promise<FleetEnrollmentOffer>;
  updateHost(hostId: string, patch: CreateHostInput & { enabled?: boolean }): Promise<HostSummary>;

  enrollment(hostId: string): Promise<FleetEnrollmentOffer>;
  /** `null` when there is no live code to void — then minting needs no confirmation. */
  enrollmentPlan(hostId: string): Promise<DestroyPlan | null>;
  enrollmentStatus(hostId: string): Promise<unknown>;

  updateAgent(hostId: string, input: { version?: string; force: boolean }): Promise<unknown>;
  updateAgentPlan(hostId: string, input: { version?: string }): Promise<DestroyPlan>;
  agentUpdateStatus(hostId: string): Promise<unknown>;

  updateFleet(hostIds: string[], version: string): Promise<unknown>;
  updateFleetPlan(hostIds: string[], version: string): Promise<DestroyPlan>;

  deleteHostPlan(hostId: string): Promise<DestroyPlan>;
  deleteHost(hostId: string): Promise<{ id: string; label: string }>;

  run(
    hostId: string,
    input: { command: string; args: string[]; cwd?: string; timeoutMs?: number },
  ): Promise<ExecOutcome>;
}

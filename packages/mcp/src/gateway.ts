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

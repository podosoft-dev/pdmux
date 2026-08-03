import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { destructive, needsInput } from "./confirm.js";
import type { FleetIdentity, PdmuxFleetGateway, PdmuxHostGateway, PdmuxTier } from "./gateway.js";

/**
 * The pdmux tool surface — two of them, for two credentials.
 *
 * HOST MODE is the original and is unchanged. The presented key is bound to one
 * host, so the host is not a parameter: there is no argument through which a caller
 * could name another machine, and therefore nothing to validate. There is likewise
 * no tool that creates a host — not filtered at call time, never registered, so it
 * cannot appear in `tools/list` either.
 *
 * FLEET MODE is for a token that reaches every host in a scope. It names machines
 * explicitly, and the two invariants above read differently there:
 *
 * ⚠ `hostId` BECOMES A PARAMETER, WHICH IS A REAL TRADE. What was structural — the
 * argument did not exist — becomes checked: `HostsService.get(scope, id)` in the API
 * implementation is what stops it reaching somebody else's machine. The test for it
 * therefore lives in the API package, next to that call, not here.
 *
 * ⚠ WHAT SURVIVES INTACT IS THE RULE THAT ACTUALLY MATTERED: no tool, in any mode,
 * at any tier, mints a credential. Creating a host row does not grow a credential's
 * scope — the row lands inside the scope the token already had. Minting a token
 * would, and revoking the original would not close it.
 *
 * Failures are RETURNED, not thrown: a model can read a stable code and correct
 * the call itself, which it cannot do with a transport-level error.
 */

export type PdmuxMcpServerOptions =
  | {
      mode: "host";
      gateway: PdmuxHostGateway;
      /** Shown in `initialize`; the host's label makes a client's UI legible. */
      hostLabel: string;
      /** A read-only key gets the same tool list, and `run_command` refuses. */
      canRun: boolean;
    }
  | {
      mode: "fleet";
      gateway: PdmuxFleetGateway;
      scopeLabel: string;
      /** Where install.sh lives, so a caller never assembles an origin. */
      origin: string;
      /** ⚠ The EFFECTIVE tier — what current authority allows, not what was granted. */
      tier: PdmuxTier;
    };

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(value: unknown): ToolResult {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: body }] };
}

function failure(error: unknown): ToolResult {
  const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "TOOL_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `${code}: ${message}` }], isError: true };
}

async function call(body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return text((await body()) ?? "done");
  } catch (error) {
    return failure(error);
  }
}

/**
 * The same failure shaping, for a body that already returns a `ToolResult`.
 *
 * ⚠ WITHOUT THIS, THE DESTRUCTIVE TOOLS LOSE THEIR ERROR CODE. The SDK does catch a
 * thrown handler error and answer `isError: true` — but with the MESSAGE only, and
 * the stable code is the whole reason `failure()` exists ("a model can read a stable
 * code and correct the call itself"). So `host_delete` on a host in another scope
 * would answer "Host not found" where every read tool answers
 * "HOST_NOT_FOUND: Host not found".
 */
async function guard(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    return failure(error);
  }
}

function registerHostTools(
  server: McpServer,
  gateway: PdmuxHostGateway,
  options: { hostLabel: string; canRun: boolean },
): void {
  server.registerTool(
    "host_detail",
    {
      description:
        "Read this host: label, addresses, whether its agent is connected, the agent version, OS/arch and capabilities. Read-only. Start here.",
      inputSchema: {},
    },
    () => call(() => gateway.detail()),
  );

  server.registerTool(
    "host_metrics",
    {
      description: "CPU, memory and disk history for this host, as aligned arrays oldest-first. Read-only.",
      inputSchema: {
        windowSec: z
          .number()
          .int()
          .min(60)
          .max(86_400)
          .default(3_600)
          .describe("How far back to read, in seconds"),
      },
    },
    ({ windowSec }) => call(() => gateway.metrics(windowSec)),
  );

  server.registerTool(
    "host_sessions",
    { description: "Terminal multiplexer sessions on this host, with attached counts. Read-only.", inputSchema: {} },
    () => call(() => gateway.sessions()),
  );

  server.registerTool(
    "host_services",
    { description: "Registered service ports on this host and their last probe status. Read-only.", inputSchema: {} },
    () => call(() => gateway.services()),
  );

  server.registerTool(
    "host_usage",
    {
      description:
        "Which coding CLIs are running on this host and how much of each budget is left. Read-only. Use it to see whether the CLI you are is even installed there.",
      inputSchema: {},
    },
    () => call(() => gateway.usage()),
  );

  server.registerTool(
    "host_repos",
    { description: "Git checkouts pdmux watches on this host, with ahead/behind and dirty counts. Read-only.", inputSchema: {} },
    () => call(() => gateway.repos()),
  );

  /**
   * ⚠ WRITE, NOT READ — AND IT WAS REGISTERED FOR EVERY KEY UNTIL 2026-08-03.
   *
   * Minting is two mutations wearing one name. It RETIRES the host's live code, so a
   * read-only key could void an install a colleague is part-way through; and the code
   * it returns is redeemable for an AGENT token, which outlives the MCP key that
   * produced it — revoking the leaked key afterwards does not take it back.
   *
   * The rule "a key can never mint another key" survives, because an agent token is a
   * machine's credential for a host this key already reaches. What did not survive is
   * "read-only" meaning read-only. Fleet mode had it right from the start: `operate`,
   * plus confirm when a code is live. This is the same gate on the same operation.
   */
  if (options.canRun) {
    server.registerTool(
      "host_install_command",
      {
        description:
          "Mint a fresh single-use enrollment code for this host and return the finished install command to run ON the host. Use when host_detail says no agent is connected. It does NOT run anything: installing means a shell on the target machine, and that belongs to the person at it. Minting retires any live code, so this asks for confirm when one exists.",
        inputSchema: { confirm: z.boolean().default(false) },
      },
      (input) =>
        guard(() =>
          destructive(
            "host_install_command",
            input,
            () => gateway.enrollmentPlan(),
            () => gateway.enrollment(),
          ),
        ),
    );
  } else {
    // Registered-and-refusing, the same shape as `run_command` below: a tool that
    // silently does not exist teaches a model to invent a way around it.
    server.registerTool(
      "host_install_command",
      {
        description: "Unavailable: this key is read-only. Minting an enrollment code retires the host's live code and yields a credential that outlives this key, so it needs a read-write key.",
        inputSchema: { confirm: z.boolean().default(false) },
      },
      () => call(() => Promise.reject(Object.assign(new Error("This key cannot mint an enrollment code"), { code: "MCP_KEY_READ_ONLY" }))),
    );
  }

  // Registered even for a read-only key, so the refusal is an answer the model
  // can read rather than a tool that mysteriously does not exist.
  server.registerTool(
    "run_command",
    {
      description: options.canRun
        ? "Run one command on this host and return its exit code, stdout and stderr. The binary and its arguments are separate: there is no shell, so `;` and `&&` are literal text. Requires a connected agent that supports exec."
        : "Unavailable: this key is read-only. Mint a read-write key in the host's Agent connection settings.",
      inputSchema: {
        command: z.string().min(1).max(256).describe("Binary name or absolute path, resolved on the host"),
        args: z.array(z.string().max(4096)).max(64).default([]).describe("Arguments, one per element — never a shell line"),
        cwd: z.string().max(1024).optional().describe("Working directory; omit for the agent's own"),
        timeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
      },
    },
    async (input) => {
      if (!options.canRun) {
        return {
          content: [
            {
              type: "text",
              text: "MCP_KEY_READ_ONLY: this key cannot run commands. Mint a read-write key for this host.",
            },
          ],
          isError: true,
        };
      }
      return call(() => gateway.run(input));
    },
  );
}

const HOST_ID = z.string().uuid().describe("Which host, from hosts_list. Never guessed — call hosts_list first.");

/**
 * What this token can reach, and — the part that earns the tool — what it cannot.
 *
 * ⚠ THIS IS WHERE "THE MODEL READS AN ANSWER RATHER THAN GUESSING" LIVES after the
 * decision not to register mutating tools below their tier. `run_command` keeps the
 * register-and-refuse shape because a model that sees no way to run things invents
 * one; there is no other way to delete a host, so listing `host_delete` to a
 * read-only token would advertise a destructive verb for no gain. Naming it here
 * costs nothing and answers the same question.
 *
 * ⚠ AND THE NOTES ARE NOT DECORATION. `notes[0]` is the ssh rule: it is the single
 * fact that decides whether a model behaves correctly when asked to "install the
 * agent", and it has to reach a client that never loaded a skill.
 */
function whoami(options: { tier: PdmuxTier; scopeLabel: string; origin: string }): FleetIdentity {
  const available = [...PDMUX_FLEET_TOOL_NAMES[options.tier]];
  const unavailable = PDMUX_FLEET_TOOL_NAMES.admin
    .filter((name) => !available.includes(name))
    .map((name) => ({
      name,
      needsTier: (PDMUX_FLEET_TOOL_NAMES.operate.includes(name) ? "operate" : "admin") as PdmuxTier,
    }));
  return {
    tier: options.tier,
    scopeLabel: options.scopeLabel,
    origin: options.origin,
    availableTools: available,
    unavailableTools: unavailable,
    notes: [
      "pdmux NEVER connects to a host and holds no ssh credentials. When something must run ON a machine, these tools hand you the command and YOU run it from your own shell — ask the user for access if you do not have it.",
      "A host's `address` is operator context only. It is free-form text pdmux never connects to; do not ssh to it without asking.",
      "An enrollment code is single-use and expires in 15 minutes. For several machines, do one at a time: create, install, verify.",
      "Accepting an agent update is not the same as it succeeding — poll host_agent_update_status.",
    ],
  };
}

/** Ordered weakest-first, so an index comparison is the tier comparison. */
const TIER_RANK: PdmuxTier[] = ["read", "operate", "admin"];
const allows = (tier: PdmuxTier, needs: PdmuxTier): boolean =>
  TIER_RANK.indexOf(tier) >= TIER_RANK.indexOf(needs);

/**
 * ⚠ WHY MUTATING TOOLS ARE NOT REGISTERED BELOW THEIR TIER, WHEN `run_command` IS.
 *
 * `run_command` is registered even for a read-only key on purpose: a model that
 * cannot see a way to run things invents another one. There is no other way to
 * delete a host, so listing `host_delete` to a token that cannot use it buys nothing
 * and advertises a destructive verb to a credential that must not have it.
 *
 * The intent behind that rule — the model reads an answer instead of guessing — is
 * kept by `pdmux_whoami`, which names every tool this token is missing and the tier
 * each needs. There is a test that says so, so nobody quietly drops the hint.
 */
function registerFleetTools(
  server: McpServer,
  gateway: PdmuxFleetGateway,
  options: { tier: PdmuxTier; scopeLabel: string; origin: string },
): void {
  const tier = options.tier;
  server.registerTool(
    "pdmux_whoami",
    {
      description:
        "What this token can reach, which tools it has, which it is missing and why. Read-only. Start here: it also states the rule that pdmux never connects to a host.",
      inputSchema: {},
    },
    () => Promise.resolve(text(whoami(options))),
  );

  server.registerTool(
    "hosts_list",
    {
      description:
        "The machines in this fleet: one short row each, with whether the agent is connected and whether it is behind. Read-only. Call this before any tool that takes a hostId.",
      inputSchema: {
        onlineOnly: z.boolean().optional().describe("Only hosts whose agent is connected right now"),
        tag: z.string().max(32).optional(),
        query: z.string().max(64).optional().describe("Substring of the label"),
      },
    },
    (input) => call(() => gateway.listHosts(input)),
  );

  server.registerTool(
    "host_detail",
    {
      description:
        "Read one host: label, addresses, whether its agent is connected, the agent version, OS/arch and capabilities. Read-only.",
      inputSchema: { hostId: HOST_ID },
    },
    ({ hostId }) => call(() => gateway.detail(hostId)),
  );

  server.registerTool(
    "host_metrics",
    {
      description: "CPU, memory and disk history for one host, as aligned arrays oldest-first. Read-only.",
      inputSchema: {
        hostId: HOST_ID,
        windowSec: z.number().int().min(60).max(86_400).default(3_600).describe("How far back to read, in seconds"),
      },
    },
    ({ hostId, windowSec }) => call(() => gateway.metrics(hostId, windowSec)),
  );

  server.registerTool(
    "host_sessions",
    { description: "Terminal multiplexer sessions on one host, with attached counts. Read-only.", inputSchema: { hostId: HOST_ID } },
    ({ hostId }) => call(() => gateway.sessions(hostId)),
  );

  server.registerTool(
    "host_services",
    { description: "Registered service ports on one host and their last probe status. Read-only.", inputSchema: { hostId: HOST_ID } },
    ({ hostId }) => call(() => gateway.services(hostId)),
  );

  server.registerTool(
    "host_usage",
    {
      description: "Which coding CLIs run on one host and how much of each budget is left. Read-only.",
      inputSchema: { hostId: HOST_ID },
    },
    ({ hostId }) => call(() => gateway.usage(hostId)),
  );

  server.registerTool(
    "host_repos",
    {
      description: "Git checkouts pdmux watches on one host, with ahead/behind and dirty counts. Read-only.",
      inputSchema: { hostId: HOST_ID },
    },
    ({ hostId }) => call(() => gateway.repos(hostId)),
  );

  server.registerTool(
    "host_enrollment_status",
    {
      description:
        "Whether a live enrollment code exists for this host and what the last attempt did. Read-only, and NEVER the code itself. This is the only place the real reason an install was refused is visible — /agent/enroll answers every failure identically on purpose.",
      inputSchema: { hostId: HOST_ID },
    },
    ({ hostId }) => call(() => gateway.enrollmentStatus(hostId)),
  );

  server.registerTool(
    "host_agent_update_status",
    {
      description:
        "How the last agent update on this host ended. Read-only. Accepting an update is not the same as it succeeding: the outcome — VERIFY_FAILED, NO_RESTART_SOURCE, PROBATION_EXPIRED and the rest — arrives here later, not from host_agent_update.",
      inputSchema: { hostId: HOST_ID },
    },
    ({ hostId }) => call(() => gateway.agentUpdateStatus(hostId)),
  );

  if (!allows(tier, "operate")) {
    // `run_command` alone keeps the register-and-refuse shape — see the comment above.
    server.registerTool(
      "run_command",
      {
        description: "Unavailable: this token is read-only. Mint an operate token on the Coding CLI access screen.",
        inputSchema: {
          hostId: HOST_ID,
          command: z.string().min(1).max(256),
          args: z.array(z.string().max(4096)).max(64).default([]),
        },
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: "MCP_TIER_INSUFFICIENT: this token is read-only. Call pdmux_whoami to see what a stronger token would add.",
          },
        ],
        isError: true,
      }),
    );
    return;
  }

  server.registerTool(
    "host_create",
    {
      description:
        "Register a machine and get the one-line install command for it, with a single-use code already in it. NOTHING IS REQUIRED: call it with no arguments and it tells you what it needs, so you can ask the user. It does NOT install anything — pdmux never connects to a host; you run the command yourself over your own ssh.",
      inputSchema: {
        label: z.string().min(1).max(64).optional().describe("How the host appears in pdmux. Unique in this fleet."),
        address: z
          .string()
          .max(255)
          .optional()
          .describe("Operator context ONLY — pdmux never connects to it. Free-form text."),
        description: z.string().max(512).optional(),
        tags: z.array(z.string().max(32)).max(32).optional(),
      },
    },
    async (input) => {
      if (!input.label || input.label.trim().length === 0) {
        return needsInput(
          "host_create",
          [
            {
              field: "label",
              required: true,
              why: "How the host appears in pdmux and how you will refer to it later. Unique within this fleet.",
              constraint: "1-64 characters, not only whitespace",
              example: "build-01",
            },
            {
              field: "address",
              required: false,
              why: "Operator context ONLY. pdmux never connects to it — the agent dials out. Put whatever you use to reach the machine yourself, or leave it empty.",
              example: "build-01.internal",
            },
          ],
          "Ask the user for these in your own conversation and call host_create again. Do not invent a label, and do not treat 'address' as somewhere pdmux will connect.",
        );
      }
      return call(() => gateway.createHost(input));
    },
  );

  server.registerTool(
    "host_update",
    {
      description: "Rename, re-tag, re-describe or disable a host. Reversible by calling again.",
      inputSchema: {
        hostId: HOST_ID,
        label: z.string().min(1).max(64).optional(),
        address: z.string().max(255).optional(),
        description: z.string().max(512).optional(),
        tags: z.array(z.string().max(32)).max(32).optional(),
        enabled: z.boolean().optional(),
      },
    },
    ({ hostId, ...patch }) => call(() => gateway.updateHost(hostId, patch)),
  );

  server.registerTool(
    "host_install_command",
    {
      description:
        "Mint a fresh single-use enrollment code for an existing host and return the finished install command. It does NOT run anything — pdmux never connects to a host, so you run it over your own ssh and ask the user for access if you do not have it. Minting retires any live code, so this asks for confirm when one exists.",
      inputSchema: { hostId: HOST_ID, confirm: z.boolean().default(false) },
    },
    (input) =>
      guard(() =>
        destructive(
          "host_install_command",
          input,
          () => gateway.enrollmentPlan(input.hostId),
          () => gateway.enrollment(input.hostId),
        ),
      ),
  );

  server.registerTool(
    "host_agent_update",
    {
      description:
        "Ask one host's agent to replace itself with a newer build. Returns that the command was ACCEPTED, not that it succeeded — poll host_agent_update_status. The plain path is safe: the agent proves the new binary can connect before swapping and restores the old one if it cannot. `force` skips the version check and is not undoable, so it needs confirm and an admin token.",
      inputSchema: {
        hostId: HOST_ID,
        version: z.string().max(32).optional().describe("Omit for the newest published build"),
        force: z.boolean().default(false),
        confirm: z.boolean().default(false),
      },
    },
    async (input) => {
      if (input.force && !allows(tier, "admin")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "MCP_TIER_INSUFFICIENT: forcing a downgrade needs an admin token. Without force this call is safe and needs no confirmation.",
            },
          ],
          isError: true,
        };
      }
      if (!input.force) {
        return call(() => gateway.updateAgent(input.hostId, { version: input.version, force: false }));
      }
      return guard(() =>
        destructive(
          "host_agent_update",
          input,
          () => gateway.updateAgentPlan(input.hostId, { version: input.version }),
          () => gateway.updateAgent(input.hostId, { version: input.version, force: true }),
        ),
      );
    },
  );

  server.registerTool(
    "run_command",
    {
      description:
        "Run one command on a host and return its exit code, stdout and stderr. The binary and its arguments are separate: there is no shell, so `;` and `&&` are literal text. Requires a connected agent that supports exec.",
      inputSchema: {
        hostId: HOST_ID,
        command: z.string().min(1).max(256).describe("Binary name or absolute path, resolved on the host"),
        args: z.array(z.string().max(4096)).max(64).default([]).describe("Arguments, one per element — never a shell line"),
        cwd: z.string().max(1024).optional(),
        timeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
      },
    },
    ({ hostId, ...input }) => call(() => gateway.run(hostId, input)),
  );

  if (!allows(tier, "admin")) return;

  server.registerTool(
    "fleet_agent_update",
    {
      description:
        "Roll one agent build out to several hosts. Refused with NO_CANARY until some host already runs it — update one with host_agent_update first. Every named machine replaces its binary and exits; there is no downgrade tool, so this needs confirm.",
      inputSchema: {
        hostIds: z.array(z.string().uuid()).min(1).max(200),
        version: z.string().min(1).max(32),
        confirm: z.boolean().default(false),
      },
    },
    (input) =>
      guard(() =>
        destructive(
          "fleet_agent_update",
          input,
          () => gateway.updateFleetPlan(input.hostIds, input.version),
          () => gateway.updateFleet(input.hostIds, input.version),
        ),
      ),
  );

  server.registerTool(
    "host_delete",
    {
      description:
        "Remove a host from pdmux. This cascades: its agent tokens, enrollment codes, services and collected history go with it, and the machine is refused until somebody re-enrols it. Needs confirm — without it you get the list of what would be destroyed.",
      inputSchema: { hostId: HOST_ID, confirm: z.boolean().default(false) },
    },
    (input) =>
      guard(() =>
        destructive(
          "host_delete",
          input,
          () => gateway.deleteHostPlan(input.hostId),
          () => gateway.deleteHost(input.hostId),
        ),
      ),
  );
}

/**
 * ⚠ THE GATEWAY LIVES INSIDE THE OPTIONS SO THE PAIRING IS A TYPE ERROR. With two
 * positional arguments, building a fleet server from a host gateway compiles and
 * fails at the first call; with a discriminated union it cannot be written.
 */
export function createPdmuxMcpServer(options: PdmuxMcpServerOptions): McpServer {
  if (options.mode === "host") {
    const server = new McpServer(
      { name: "pdmux", version: "0.1.0" },
      { instructions: `Tools act on the pdmux host "${options.hostLabel}". No tool takes a host id.` },
    );
    registerHostTools(server, options.gateway, options);
    return server;
  }

  // Read once, before any tool call, and it decides behaviour — so the sentence that
  // matters most is the ssh one rather than anything about the tools.
  const server = new McpServer(
    { name: "pdmux", version: "0.1.0" },
    {
      instructions:
        `Tools act on the pdmux hosts in "${options.scopeLabel}". Every tool that names a machine takes ` +
        "hostId; call hosts_list first. pdmux NEVER connects to a host and holds no ssh credentials — " +
        "when something must run ON a machine these tools hand you the exact command and YOU run it from " +
        "your own shell, asking the user for access if you do not already have it. A host's `address` is " +
        "operator context only, never somewhere pdmux connects. Destructive tools answer a call without " +
        "`confirm: true` by describing what they would destroy.",
    },
  );
  registerFleetTools(server, options.gateway, options);
  return server;
}

/** The names a client should see. Exported so a contract test can assert on it. */
export const PDMUX_TOOL_NAMES = [
  "host_detail",
  "host_metrics",
  "host_sessions",
  "host_services",
  "host_usage",
  "host_repos",
  "host_install_command",
  "run_command",
] as const;

/**
 * The fleet-mode names, by tier. A contract test asserts `tools/list` equals the
 * cumulative list for each tier, against a LITERAL written in the test — an
 * imported constant cannot catch a widening, because whoever adds a tool adds it to
 * both sides.
 */
export const PDMUX_FLEET_TOOL_NAMES: Record<PdmuxTier, readonly string[]> = {
  read: [
    "pdmux_whoami",
    "hosts_list",
    "host_detail",
    "host_metrics",
    "host_sessions",
    "host_services",
    "host_usage",
    "host_repos",
    "host_enrollment_status",
    "host_agent_update_status",
    "run_command",
  ],
  operate: [
    "pdmux_whoami",
    "hosts_list",
    "host_detail",
    "host_metrics",
    "host_sessions",
    "host_services",
    "host_usage",
    "host_repos",
    "host_enrollment_status",
    "host_agent_update_status",
    "host_create",
    "host_update",
    "host_install_command",
    "host_agent_update",
    "run_command",
  ],
  admin: [
    "pdmux_whoami",
    "hosts_list",
    "host_detail",
    "host_metrics",
    "host_sessions",
    "host_services",
    "host_usage",
    "host_repos",
    "host_enrollment_status",
    "host_agent_update_status",
    "host_create",
    "host_update",
    "host_install_command",
    "host_agent_update",
    "run_command",
    "fleet_agent_update",
    "host_delete",
  ],
};

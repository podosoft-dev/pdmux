import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { PdmuxHostGateway } from "./gateway.js";

/**
 * The pdmux tool surface.
 *
 * ⚠ NO TOOL TAKES A HOST ID. The presented key is bound to one host, so the host
 * is not a parameter — there is no argument through which a caller could name
 * another machine, and therefore nothing to validate. That is the whole reason
 * the tools read the way they do ("this host", never "a host").
 *
 * ⚠ THERE IS NO TOOL THAT CREATES A HOST. A person registers a machine in the
 * dashboard and then hands its key to a CLI; a key that could register more would
 * be a credential that grows its own scope. It is not filtered at call time — it is
 * never registered, so it cannot appear in `tools/list` either.
 *
 * Failures are RETURNED, not thrown: a model can read a stable code and correct
 * the call itself, which it cannot do with a transport-level error.
 */

export interface PdmuxMcpServerOptions {
  /** Shown in `initialize`; the host's label makes a client's UI legible. */
  hostLabel: string;
  /** A read-only key gets the same tool list, and `run_command` refuses. */
  canRun: boolean;
}

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

export function createPdmuxMcpServer(gateway: PdmuxHostGateway, options: PdmuxMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "pdmux", version: "0.1.0" },
    { instructions: `Tools act on the pdmux host "${options.hostLabel}". No tool takes a host id.` },
  );

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

  server.registerTool(
    "host_install_command",
    {
      description:
        "Mint a fresh single-use enrollment code for this host and return the finished install command to run ON the host. Use when host_detail says no agent is connected. It does NOT run anything: installing means a shell on the target machine, and that belongs to the person at it. Minting retires any previous code.",
      inputSchema: {},
    },
    () => call(() => gateway.enrollment()),
  );

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

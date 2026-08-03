#!/usr/bin/env node
/**
 * An MCP server for enrolling pdmux agents across a fleet.
 *
 * WHY IT EXISTS: installing an agent is a three-step loop — register the host, run
 * the one-liner on it, confirm it connected — and the middle step is the only one a
 * coding agent can already do well. The other two mean an authenticated call and
 * reading a response shape. Handing those over as tools turns "install pdmux on
 * these twelve machines" into a loop the agent can actually run, instead of a dozen
 * hand-copied dashboard visits.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not run the installer. That means SSH,
 * and SSH means credentials and a target list, which belong to the operator's own
 * shell where they can be seen. The tools hand back the exact command to run.
 *
 * The protocol is spoken directly rather than through an SDK: MCP over stdio is
 * JSON-RPC 2.0, and this needs three methods. No new dependency for a tool.
 *
 * Configuration, all from the environment:
 *   PDMUX_ORIGIN    https origin of the deployment, e.g. https://pdmux.example.com
 *   PDMUX_EMAIL     administrator email
 *   PDMUX_PASSWORD  administrator password
 */
import { createInterface } from "node:readline";

const ORIGIN = (process.env.PDMUX_ORIGIN ?? "").replace(/\/+$/, "");
const EMAIL = process.env.PDMUX_EMAIL ?? "";
const PASSWORD = process.env.PDMUX_PASSWORD ?? "";

/** The session cookie, kept for the process lifetime. Never logged. */
let cookie = null;

function configurationError() {
  const missing = [
    ["PDMUX_ORIGIN", ORIGIN],
    ["PDMUX_EMAIL", EMAIL],
    ["PDMUX_PASSWORD", PASSWORD],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return missing.length ? `Set ${missing.join(", ")} before using these tools.` : null;
}

async function signIn() {
  const response = await fetch(`${ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`Sign-in failed with ${response.status}. Check PDMUX_EMAIL and PDMUX_PASSWORD.`);
  }
  const setCookie = response.headers.getSetCookie?.() ?? [];
  cookie = setCookie.map((entry) => entry.split(";", 1)[0]).join("; ");
  if (!cookie) throw new Error("Sign-in returned no session cookie.");
}

/**
 * One authenticated call, signing in on demand and retrying once if the session
 * expired underneath us.
 */
async function api(path, init = {}, retry = true) {
  if (!cookie) await signIn();
  const response = await fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie,
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 401 && retry) {
    cookie = null;
    return api(path, init, false);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** The command an operator pastes on the target machine. */
function installCommand(code) {
  return `curl -fsSL ${ORIGIN}/install.sh | sh -s -- --code ${code}`;
}

function hostSummary(host) {
  return {
    id: host.id,
    label: host.label,
    online: host.online ?? false,
    agentVersion: host.agentVersion ?? null,
    os: host.os ?? null,
    arch: host.arch ?? null,
    capabilities: host.capabilities ?? [],
  };
}

const TOOLS = [
  {
    name: "list_hosts",
    description:
      "List the fleet: which hosts exist, whether each one is online, and what its agent reports. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => (await api("/api/hosts")).map(hostSummary),
  },
  {
    name: "host_detail",
    description: "Read one host by id, including its services and reported capabilities. Read-only.",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string", description: "Host UUID" } },
      required: ["hostId"],
      additionalProperties: false,
    },
    handler: async ({ hostId }) => api(`/api/hosts/${encodeURIComponent(hostId)}`),
  },
  {
    name: "register_host",
    description:
      "Register a new host and return its one-time enrollment code together with the install command to run on that machine. The code is single-use and expires in fifteen minutes, so register immediately before installing rather than in a batch up front.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "How the host appears in the dashboard" },
        address: { type: "string", description: "Address the dashboard shows for it" },
      },
      required: ["label"],
      additionalProperties: false,
    },
    handler: async ({ label, address }) => {
      const created = await api("/api/hosts", {
        method: "POST",
        body: JSON.stringify({ label, ...(address ? { address } : {}) }),
      });
      const code = created?.enrollment?.code ?? null;
      return {
        host: hostSummary(created),
        enrollmentIssued: Boolean(code),
        installCommand: code ? installCommand(code) : null,
        note: code
          ? "Single-use, expires in fifteen minutes. Run it on the target machine, then confirm with list_hosts."
          : "No enrollment code was issued; use issue_enrollment.",
      };
    },
  },
  {
    name: "issue_enrollment",
    description:
      "Mint a fresh enrollment code for an existing host and return the install command. Issuing a new code discards the host's previous one in the same call, which is how an expired or mistyped code is recovered.",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string", description: "Host UUID" } },
      required: ["hostId"],
      additionalProperties: false,
    },
    handler: async ({ hostId }) => {
      const minted = await api(`/api/hosts/${encodeURIComponent(hostId)}/enrollments`, {
        method: "POST",
      });
      const code = minted?.code ?? null;
      if (!code) throw new Error("The API returned no enrollment code.");
      return {
        installCommand: installCommand(code),
        note: "Single-use, expires in fifteen minutes. The host's previous code is now void.",
      };
    },
  },
  {
    name: "enrollment_status",
    description:
      "Read whether a host has a live enrollment and what happened to the last attempt. Never returns the code itself — that exists in exactly one response and is unrecoverable afterwards. This is where to look when an installer reports a generic 401.",
    inputSchema: {
      type: "object",
      properties: { hostId: { type: "string", description: "Host UUID" } },
      required: ["hostId"],
      additionalProperties: false,
    },
    handler: async ({ hostId }) =>
      (await api(`/api/hosts/${encodeURIComponent(hostId)}/enrollments/current`)) ?? {
        enrollment: null,
        note: "No enrollment on record for this host.",
      },
  },
];

const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`,
  );
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "pdmux-fleet", version: "0.1.0" },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
    return;
  }
  if (method === "tools/call") {
    const tool = byName.get(params?.name);
    if (!tool) return replyError(id, `Unknown tool: ${params?.name}`);
    const problem = configurationError();
    if (problem) {
      reply(id, { content: [{ type: "text", text: problem }], isError: true });
      return;
    }
    try {
      const result = await tool.handler(params.arguments ?? {});
      reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (error) {
      reply(id, { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true });
    }
    return;
  }
  if (id !== undefined) replyError(id, `Unsupported method: ${method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  void handle(request).catch((error) => {
    if (request.id !== undefined) replyError(request.id, String(error?.message ?? error));
  });
});

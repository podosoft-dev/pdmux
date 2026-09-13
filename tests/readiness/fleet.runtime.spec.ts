import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { reserveLoopbackPort } from "../../apps/desktop/src/stack-manager";
import { test, expect, json, type ReadinessRuntime } from "./fixture";
import { ready } from "../helpers/hydration";
import { publicHttp } from "./public-http";

interface Host { id: string; label: string; online: boolean; connected: boolean; }
interface Offer { hostId: string; installCommand: string; }
let hostId = "";

async function connect(base: string, token: string): Promise<Client> {
  const client = new Client({ name: "pdmux-readiness", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `${name} failed`).not.toBe(true);
  if (!Array.isArray(result.content)) throw new Error("Missing MCP content");
  const content: unknown = result.content[0];
  if (typeof content !== "object" || content === null || !("text" in content) || typeof content.text !== "string") throw new Error("Missing MCP text result");
  return JSON.parse(content.text) as T;
}

async function signIn(context: BrowserContext, account: APIRequestContext): Promise<void> {
  const state = await account.storageState();
  await context.addCookies(state.cookies);
  await context.addCookies([{ name: "locale", value: "en", domain: "127.0.0.1", path: "/" }]);
}

async function open(page: Page, runtime: ReadinessRuntime, path: string): Promise<void> {
  await ready(page, `${runtime.webUrl}${path}`);
}

test.describe.serial("isolated fleet readiness", () => {
  test("[TC-PDMCP-061] MCP registers, installs and operates a real agent", async ({ runtime }) => {
    await json(await runtime.owner.put("/api/fleet/settings", { data: { mcpUserTokens: true, gitRoots: [], usageProviders: [] } }));
    const token = await json<{ token: string }>(await runtime.owner.post("/api/account/mcp-tokens", { data: { label: "Readiness", tier: "admin", expiresInDays: 7 } }));
    const client = await connect(runtime.webUrl, token.token);
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("host_create");
      expect(await call<Host[]>(client, "hosts_list")).toEqual([]);
      const offer = await call<Offer>(client, "host_create", { label: "readiness-agent" });
      hostId = offer.hostId;
      expect(hostId).toBeTruthy();
      await runtime.installAgent(offer.installCommand);
      await expect.poll(async () => (await call<Host>(client, "host_detail", { hostId })).online, { timeout: 30_000 }).toBe(true);
      const key = await json<{ key: string }>(await runtime.owner.post(`/api/hosts/${hostId}/mcp-keys`, { data: { label: "Readiness host", scopes: ["read", "write"], expiresInDays: 30 } }));
      const hostClient = await connect(runtime.webUrl, key.key);
      try {
        expect((await hostClient.listTools()).tools.map(tool => tool.name)).toContain("run_command");
        expect((await call<Host>(hostClient, "host_detail")).online).toBe(true);
        const executed = await call<{ stdout: string; exitCode: number }>(hostClient, "run_command", { command: "printf", args: ["pdmux-readiness-ok"] });
        expect(executed.exitCode).toBe(0);
        expect(executed.stdout).toBe("pdmux-readiness-ok");
      } finally { await hostClient.close(); }
    } finally { await client.close(); }
  });

  test("[TC-PDADMIN-040] saving settings reaches a connected agent", async ({ runtime, page, context }) => {
    await signIn(context, runtime.owner);
    await open(page, runtime, "/settings");
    await page.getByTestId("fleet-field-heartbeatSec").fill("2");
    await page.getByTestId("fleet-save").click();
    await expect(page.getByTestId("fleet-save")).toBeDisabled();
    expect((await json<{ heartbeatSec: number }>(await runtime.owner.get("/api/fleet/settings"))).heartbeatSec).toBe(2);
    // The real agent changes heartbeat cadence on config frames; observing two
    // distinct server timestamps proves the setting reached the running process.
    const timestamps: number[] = [];
    await expect.poll(async () => {
      const host = await json<{ lastSeenAt: string }>(await runtime.owner.get(`/api/hosts/${hostId}`));
      const timestamp = Date.parse(host.lastSeenAt);
      if (timestamps.at(-1) !== timestamp) timestamps.push(timestamp);
      return timestamps.length;
    }, { timeout: 15_000, intervals: [250] }).toBeGreaterThanOrEqual(3);
    const intervals = timestamps.slice(1).map((timestamp, index) => timestamp - timestamps[index]!);
    expect(intervals.at(-1)).toBeGreaterThan(1_000);
    expect(intervals.at(-1)).toBeLessThan(3_500);
    await page.screenshot({ path: test.info().outputPath("fleet-settings.png") });
  });

  test("[TC-PDFILE-010] authenticated production routes transfer folders and resume ZIP downloads", async ({ runtime }) => {
    const base = `/api/hosts/${hostId}/file-transfers`;
    const payload = Buffer.alloc(1_048_576 + 17, 0x41);
    const chunks = [payload.subarray(0, 1_048_576), payload.subarray(1_048_576)];
    const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
    const entries = [
      { id: randomUUID(), path: "folder", kind: "directory", size: 0, fingerprint: "", modified: "" },
      { id: randomUUID(), path: "folder/empty", kind: "directory", size: 0, fingerprint: "", modified: "" },
      { id: randomUUID(), path: "folder/file.txt", kind: "file", size: payload.length, fingerprint: hash(chunks.map(hash).join("")), modified: "" },
    ];
    const file = entries[2]!;
    await runtime.executeAgent(["mkdir", "-p", "/root/readiness-transfer"]);
    const id = randomUUID();
    await json(await runtime.owner.post(base, { data: { id, direction: "upload", basePath: "readiness-transfer", selection: [] } }));
    expect((await runtime.other.get(`${base}/${id}`)).status()).toBe(404);
    await json(await runtime.owner.post(`${base}/${id}/manifest`, { data: { entries } }));
    await json(await runtime.owner.post(`${base}/${id}/control`, { data: { action: "start" } }));
    for (const entry of entries.slice(0, 2)) await json(await runtime.owner.post(`${base}/${id}/entries/${entry.id}/commit`));
    let offset = 0;
    for (const chunk of chunks) {
      await json(await runtime.owner.put(`${base}/${id}/entries/${file.id}/chunk`, {
        data: chunk, headers: { "content-type": "application/octet-stream", "x-transfer-offset": String(offset), "x-transfer-sha256": hash(chunk) },
      }));
      offset += chunk.length;
      await json(await runtime.owner.post(`${base}/${id}/control`, { data: { action: "pause" } }));
      await json(await runtime.owner.post(`${base}/${id}/control`, { data: { action: "start" } }));
      expect((await json<{ offset: number }>(await runtime.owner.post(`${base}/${id}/entries/${file.id}/reconcile`))).offset).toBe(offset);
    }
    await json(await runtime.owner.post(`${base}/${id}/entries/${file.id}/commit`));
    expect((await runtime.executeAgent(["sha256sum", "/root/readiness-transfer/folder/file.txt"])).split(" ")[0]).toBe(hash(payload));
    await runtime.executeAgent(["test", "-d", "/root/readiness-transfer/folder/empty"]);
    const downloadId = randomUUID();
    await json(await runtime.owner.post(base, { data: { id: downloadId, direction: "download", basePath: "readiness-transfer", selection: ["folder"] } }));
    await json(await runtime.owner.post(`${base}/${downloadId}/control`, { data: { action: "start" } }));
    await expect.poll(async () => (await json<{ state: string }>(await runtime.owner.get(`${base}/${downloadId}`))).state).toBe("ready");
    const download = await runtime.owner.get(`${base}/${downloadId}/download`);
    expect(download.status()).toBe(200);
    expect(download.headers()["content-type"]).toContain("application/zip");
    const archive = await download.body();
    expect(download.headers()["etag"]).toBe('"' + hash(archive) + '"');
    expect(archive.includes(Buffer.from("folder/empty/"))).toBe(true);
    const resumed = await runtime.owner.get(`${base}/${downloadId}/download`, { headers: { range: "bytes=23-", "if-range": download.headers()["etag"]! } });
    const direct = await runtime.owner.get(`${runtime.apiUrl}${base.slice(4)}/${downloadId}/download`, { headers: { range: "bytes=23-", "if-range": download.headers()["etag"]! } });
    expect(direct.status()).toBe(206);
    expect(await direct.body()).toEqual(archive.subarray(23));
    expect(resumed.status()).toBe(206);
    expect(await resumed.body()).toEqual(archive.subarray(23));
    await json(await runtime.owner.post(`${base}/${downloadId}/control`, { data: { action: "cancel" } }));
  });

  test("[TC-PDADMIN-030] host and real terminal actions appear in the audit UI", async ({ runtime, page, context }) => {
    await signIn(context, runtime.owner);
    const config = await json<{ server: { auditLog: boolean } }>(await runtime.owner.put("/api/account/auth-config", { data: { server: { auditLog: true } } }));
    expect(config.server.auditLog).toBe(true);
    const created = await json<Host>(await runtime.owner.post("/api/hosts", { data: { label: "audit-created-host", tags: [] } }));
    try {
      await open(page, runtime, `/terminal?host=${hostId}&kind=new&session=readiness`);
      const surface = page.locator("[data-pdmux-surface]");
      await expect(surface.locator(".xterm-rows")).toBeVisible();
      await expect.poll(async () => (await surface.innerText()).trim().length).toBeGreaterThan(0);
      await surface.click();
      await page.keyboard.type("printf 'readiness-audit-ok\\n'");
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await surface.innerText()).split("readiness-audit-ok").length).toBeGreaterThanOrEqual(3);
      await page.keyboard.type("exit");
      await page.keyboard.press("Enter");
      await open(page, runtime, "/admin/audit");
      await expect(page.getByRole("row").filter({ hasText: "host.create" }).filter({ hasText: created.label })).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: "terminal.open" }).filter({ hasText: "readiness-agent" })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("audit.png") });
    } finally { await runtime.owner.delete(`/api/hosts/${created.id}`); }
  });

  test("[TC-PDWEB-035] live SSE updates precede polling and polling survives an unavailable stream", async ({ runtime, page, context }) => {
    await signIn(context, runtime.owner);
    await json(await runtime.owner.put("/api/fleet/settings", { data: { heartbeatSec: 30 } }));
    const events: string[] = [];
    const connection = await page.context().newCDPSession(page);
    await connection.send("Network.enable");
    connection.on("Network.eventSourceMessageReceived", (event: { data: string }) => { events.push(event.data); });
    await open(page, runtime, "/hosts");
    await expect.poll(() => events.some(event => event.includes('"ready"'))).toBe(true);
    await json(await runtime.owner.patch(`/api/hosts/${hostId}`, { data: { label: "readiness-live" } }));
    // A real agent hello supplies an event immediately, well before the 30s poll.
    await runtime.executeAgent(["sh", "-c", "pkill -f '^/usr/local/bin/pdmux-agent run' || true"]);
    await runtime.executeAgent(["sh", "-c", "nohup /usr/local/bin/pdmux-agent run --config /etc/pdmux/agent.json >/tmp/agent.log 2>&1 </dev/null &"]);
    await expect.poll(() => events.some(event => event.includes('"hosts.changed"')), { timeout: 10_000 }).toBe(true);
    await expect(page.getByText("readiness-live", { exact: true }).first()).toBeVisible({ timeout: 3_000 });
    expect(events.every(event => !event.includes(hostId))).toBe(true);
    await page.screenshot({ path: test.info().outputPath("fleet-live.png") });
    await connection.detach();
    await json(await runtime.owner.put("/api/fleet/settings", { data: { heartbeatSec: 2 } }));
    await page.route("**/api/fleet/events", route => route.abort("failed"));
    await page.reload();
    await json(await runtime.owner.patch(`/api/hosts/${hostId}`, { data: { label: "readiness-poll-recovered" } }));
    await expect(page.getByText("readiness-poll-recovered", { exact: true }).first()).toBeVisible({ timeout: 7_000 });
  });

  test("[TC-PDEXTERNAL-012] a real Cloudflare tunnel protects, publishes and removes an isolated service", async ({ runtime }) => {
    test.setTimeout(240_000);
    const configPath = process.env.READINESS_CLOUDFLARE;
    test.skip(!configPath, "Set READINESS_CLOUDFLARE to a private configuration file to change a real test hostname");
    if (!configPath) return;
    const { hostname, ...config } = JSON.parse(await readFile(configPath, "utf8")) as {
      hostname: string; apiToken: string; zoneId: string; baseDomain: string; accessPolicyId: string;
    };
    const port = await reserveLoopbackPort();
    await runtime.executeAgent(["sh", "-c", "mkdir -p /tmp/readiness-www && printf 'pdmux-cloudflare-readiness' >/tmp/readiness-www/index.html"]);
    await runtime.executeAgent(["sh", "-c", `httpd -p 127.0.0.1:${port} -h /tmp/readiness-www`]);
    await json(await runtime.owner.put("/api/integrations/cloudflare", { data: config }));
    const service = await json<{ id: string }>(await runtime.owner.post(`/api/hosts/${hostId}/services`, { data: { label: "Cloudflare readiness", port, probe: "http", path: "/" } }));
    const prefix = `/api/hosts/${hostId}/services/${service.id}/exposures`;
    try {
      const exposure = await json<{ id: string }>(await runtime.owner.post(prefix, { data: { hostname, mode: "access", originScheme: "http" } }));
      await expect.poll(async () => {
        const exposures = await json<{ connector: { state: string } | null }[]>(await runtime.owner.get(`/api/hosts/${hostId}/exposures`));
        return exposures[0]?.connector?.state;
      }, { timeout: 90_000, intervals: [2_000] }).toBe("connected");
      await expect.poll(async () => {
        const response = await publicHttp(hostname).catch(() => null);
        return response?.location.includes("cloudflareaccess.com") ?? false;
      }, { timeout: 90_000, intervals: [2_000] }).toBe(true);
      await json(await runtime.owner.patch(`${prefix}/${exposure.id}`, { data: { hostname, mode: "public", originScheme: "http", confirmPublic: true } }));
      await expect.poll(async () => {
        const response = await publicHttp(hostname).catch(() => null);
        return response?.status === 200 ? response.body : "pending";
      }, { timeout: 90_000, intervals: [2_000] }).toBe("pdmux-cloudflare-readiness");
    } finally {
      const exposures = await json<{ id: string }[]>(await runtime.owner.get(`/api/hosts/${hostId}/exposures`));
      for (const exposure of exposures) await json(await runtime.owner.delete(`${prefix}/${exposure.id}`));
      await json(await runtime.owner.delete(`/api/hosts/${hostId}/services/${service.id}`));
      await json(await runtime.owner.delete("/api/integrations/cloudflare"));
    }
  });

  test("[TC-PDADMIN-010] two organization sessions isolate lists and direct host URLs", async ({ runtime, browser }) => {
    const accounts = [runtime.owner, runtime.other];
    const hosts: Host[] = [];
    const organizations: string[] = [];
    try {
      for (const [index, account] of accounts.entries()) {
        const organization = await json<{ id: string }>(await account.post("/api/auth/organization/create", { data: { name: `Readiness ${index}`, slug: `readiness-${index}` } }));
        organizations.push(organization.id);
        await json(await account.post("/api/auth/organization/set-active", { data: { organizationId: organization.id } }));
        hosts.push(await json<Host>(await account.post("/api/hosts", { data: { label: `organization-${index}-private`, tags: [] } })));
      }
      for (const [index, account] of accounts.entries()) {
        const own = hosts[index]!;
        const foreign = hosts[1 - index]!;
        const context = await browser.newContext();
        try {
          await signIn(context, account);
          const page = await context.newPage();
          await open(page, runtime, "/hosts");
          await expect(page.getByText(own.label, { exact: true }).first()).toBeVisible();
          await expect(page.getByText(foreign.label, { exact: true })).toHaveCount(0);
          expect((await account.get(`/api/hosts/${foreign.id}`)).status()).toBe(404);
          const response = await page.goto(`${runtime.webUrl}/hosts/${foreign.id}`);
          expect(response?.status()).toBe(404);
          await expect(page.getByText(foreign.label, { exact: true })).toHaveCount(0);
          await page.screenshot({ path: test.info().outputPath(`organization-${index}.png`) });
        } finally { await context.close(); }
      }
    } finally {
      for (const [index, account] of accounts.entries()) {
        if (hosts[index]) await account.delete(`/api/hosts/${hosts[index]!.id}`);
        if (organizations[index]) await account.post("/api/auth/organization/delete", { data: { organizationId: organizations[index] } });
        await account.post("/api/auth/organization/set-active", { data: { organizationId: null } });
      }
    }
  });
});

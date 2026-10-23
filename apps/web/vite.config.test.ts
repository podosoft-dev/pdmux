import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { createServer, type UserConfig, type ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import config, { refreshRecreatedFiles, webSocketProxy } from "./vite.config.ts";

async function resolved(command: "serve" | "build"): Promise<UserConfig> {
  return await config({ command, mode: command === "serve" ? "development" : "production" });
}

describe("dev-server browser errors", () => {
  it("logs the browser's uncaught errors and console errors with the dev server's output", async () => {
    // A page that fails to hydrate otherwise leaves nothing in the server log.
    expect((await resolved("serve")).server?.forwardConsole).toEqual({ unhandledErrors: true, logLevels: ["error"] });
    expect((await resolved("build")).server?.forwardConsole).toBeUndefined();
  });
});

describe("dev-server WebSocket proxy", () => {
  it("sends each exact path in .podokit/dev.json to the API", () => {
    const proxy = webSocketProxy(
      JSON.stringify({ hostname: "app.localhost", webSocketPaths: ["/events/ws", "/agent.v1/ws"] }),
      "http://api:5002",
    );

    expect(proxy).toEqual({
      "^/events/ws(?:\\?.*)?$": { target: "http://api:5002", ws: true, xfwd: true },
      "^/agent\\.v1/ws(?:\\?.*)?$": { target: "http://api:5002", ws: true, xfwd: true },
    });
    const [events] = Object.keys(proxy).map((key) => new RegExp(key));
    expect(events?.test("/events/ws")).toBe(true);
    expect(events?.test("/events/ws?token=1")).toBe(true);
    expect(events?.test("/events/ws/other")).toBe(false);
    expect(events?.test("/events/wsx")).toBe(false);
  });

  it("proxies nothing without the file or its paths", () => {
    expect(webSocketProxy(null)).toEqual({});
    expect(webSocketProxy(JSON.stringify({ hostname: "app.localhost" }))).toEqual({});
  });

  it("rejects a path the gateway would reject", () => {
    expect(() => webSocketProxy(JSON.stringify({ webSocketPaths: ["events/ws"] }))).toThrow(
      'invalid path: "events/ws"',
    );
    expect(() => webSocketProxy(JSON.stringify({ webSocketPaths: "/events/ws" }))).toThrow("must be an array");
  });
});

async function servedCode(server: ViteDevServer, url: string, expected: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let code = "";
  while (Date.now() < deadline) {
    code = (await server.environments.client.transformRequest(url))?.code ?? "";
    if (code.includes(expected)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return code;
}

describe("dev server after a file is deleted and created again", () => {
  it("serves the re-created component instead of its first transform", async () => {
    // Inside the app, so the compiled component resolves svelte from its node_modules.
    const root = mkdtempSync(join(import.meta.dirname, ".recreated-component-"));
    const file = join(root, "Probe.svelte");
    writeFileSync(file, "<p>first version</p>\n");
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [refreshRecreatedFiles(), svelte()],
      // No file watcher: the test sends the events itself, so it does not depend
      // on how the platform reports a delete and create (macOS may merge them).
      server: { middlewareMode: true, ws: false, watch: null },
    });
    try {
      expect(await servedCode(server, "/Probe.svelte", "first version")).toContain("first version");

      unlinkSync(file);
      server.watcher.emit("unlink", file);
      writeFileSync(file, "<p>second version</p>\n");
      server.watcher.emit("add", file);

      expect(await servedCode(server, "/Probe.svelte", "second version")).toContain("second version");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});


import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { webSocketProxy } from "../vite.config";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}/${path}`, "utf8");

/** The directives inside each `reverse_proxy <upstream> { … }` block of a Caddyfile, by upstream. */
const proxyBlocks = (caddyfile: string): Map<string, string> =>
  new Map([...caddyfile.matchAll(/reverse_proxy (\S+) \{\n([\s\S]*?)\n[ \t]*\}/g)]
    .map(([, upstream = "", body = ""]) => [upstream, body.trim()]));

describe("WebSocket gateway routing", () => {
  it("registers both exact socket paths with the shared development gateway", () => {
    const config = JSON.parse(read(".podokit/dev.json")) as {
      webSocketPaths: string[];
    };
    expect(config.webSocketPaths).toEqual(["/agent/ws", "/terminal/ws"]);
  });

  it("routes both public socket paths through Vite during development", () => {
    // The managed vite.config.ts proxies exactly the paths .podokit/dev.json lists.
    const proxy = webSocketProxy(read(".podokit/dev.json"), "http://api:5002");
    expect(Object.keys(proxy).map((key) => new RegExp(key)).map((path) => [
      path.test("/agent/ws"),
      path.test("/terminal/ws"),
    ])).toEqual([[true, false], [false, true]]);
    expect(Object.values(proxy).every((rule) => rule.ws === true)).toBe(true);
  });

  it("[TC-PDTERM-107] routes only the two exact socket paths to the API in self-hosted deployments", () => {
    const caddy = read("infra/docker/Caddyfile");
    expect(caddy).toContain("@websockets path /terminal/ws /agent/ws");
    expect(caddy).toMatch(/handle @websockets \{\s+reverse_proxy api:5002\b/);
    expect(caddy).toMatch(/handle \{\s+reverse_proxy web:3000\b/);
  });

  it("[TC-PDTERM-108] leaves upgrades to the native reverse proxy and sends one client address", () => {
    const caddy = read("infra/docker/Caddyfile");
    // The web server (XFF_DEPTH=1) and the API (TRUSTED_PROXY_HOPS=1) take the last entry, so
    // Caddy's default of appending a trusted proxy's address would be recorded as the client.
    expect(proxyBlocks(caddy)).toEqual(new Map([
      ["api:5002", "header_up X-Forwarded-For {client_ip}"],
      ["web:3000", "header_up X-Forwarded-For {client_ip}"],
    ]));
    expect(caddy).not.toMatch(/header_up\s+-(?:Cookie|Connection|Upgrade|X-Forwarded-)/i);
  });

  it("[TC-PDTERM-109] keeps socket lifecycle handling out of the SvelteKit server", () => {
    const packageJson = JSON.parse(read("apps/web/package.json")) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.start ?? "").not.toMatch(/server\.js|terminal-upgrade/);
    expect(read("apps/web/Dockerfile")).not.toMatch(/server\.js|terminal-upgrade/);
  });

  it("uses exact API routes ahead of the web fallback in k3s", () => {
    const ingress = read("infra/k3s/ingress.yaml");
    for (const path of ["/terminal/ws", "/agent/ws"]) {
      expect(ingress).toContain(`- path: ${path}\n            pathType: Exact`);
    }
    expect(ingress.indexOf("- path: /terminal/ws")).toBeLessThan(ingress.indexOf("- path: /\n"));
    expect(ingress.indexOf("- path: /agent/ws")).toBeLessThan(ingress.indexOf("- path: /\n"));
  });
});

describe("Web image assets", () => {
  it("builds agent downloads before the SvelteKit output is assembled", () => {
    const dockerfile = read("apps/web/Dockerfile");
    const buildAgent = dockerfile.indexOf("RUN bun tools/build-agent-binaries.mjs");
    const copyAgent = dockerfile.indexOf("COPY --from=agent /src/apps/web/static/agent");
    const buildWeb = dockerfile.indexOf("RUN bun run --cwd apps/web build");
    expect(buildAgent).toBeGreaterThan(-1);
    expect(copyAgent).toBeGreaterThan(buildAgent);
    expect(buildWeb).toBeGreaterThan(copyAgent);
  });

  it("probes the web server's own health route, which never calls the API", () => {
    // `/` fails closed with 503 while the API is down, which would mark a web
    // container that can still serve its fallbacks unhealthy.
    const healthcheck = /^HEALTHCHECK[^\n]*\\\n\s*CMD (.*)$/m.exec(read("apps/web/Dockerfile"));
    expect(healthcheck?.[1]).toContain("+ '/healthz')");
  });
});

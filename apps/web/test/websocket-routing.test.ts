import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}/${path}`, "utf8");

describe("WebSocket gateway routing", () => {
  it("registers both exact socket paths with the shared development gateway", () => {
    const config = JSON.parse(read(".podokit/dev.json")) as {
      webSocketPaths: string[];
    };
    expect(config.webSocketPaths).toEqual(["/agent/ws", "/terminal/ws"]);
  });

  it("routes both public socket paths through Vite during development", () => {
    const config = read("apps/web/vite.config.ts");
    expect(config).toContain('"/terminal/ws": { target:');
    expect(config).toContain('"/agent/ws": { target:');
    expect(config.match(/ws: true/g)).toHaveLength(2);
  });

  it("[TC-PDTERM-107] routes only the two exact socket paths to the API in self-hosted deployments", () => {
    const caddy = read("infra/docker/Caddyfile");
    expect(caddy).toContain("@websockets path /terminal/ws /agent/ws");
    expect(caddy).toMatch(/handle @websockets \{\s+reverse_proxy api:5002\s+\}/);
    expect(caddy).toMatch(/handle \{\s+reverse_proxy web:3000\s+\}/);
  });

  it("[TC-PDTERM-108] delegates upgrade and forwarded headers to the native reverse proxy", () => {
    const caddy = read("infra/docker/Caddyfile");
    expect(caddy).toMatch(/handle @websockets \{\s+reverse_proxy api:5002\s+\}/);
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
});

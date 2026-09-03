import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const source = readFileSync(join(process.cwd(), "src", "pdmux", "pdmux.http.ts"), "utf8");

const MUTATION_AUDIT_ACTIONS = [
  "fleet.settings.update",
  "integration.cloudflare.connect",
  "integration.cloudflare.disconnect",
  "host.create",
  "host.update",
  "host.delete",
  "host.enable",
  "host.move",
  "host.reorder",
  "host.service.create",
  "host.service.reorder",
  "host.service.update",
  "host.service.delete",
  "host.service.exposure.create",
  "host.service.exposure.update",
  "host.service.exposure.delete",
  "host.gitroot.create",
  "host.gitroot.update",
  "host.gitroot.delete",
  "agent.enrollment.create",
  "agent.enrollment.revoke",
  "agent.token.create",
  "agent.token.rotate",
  "agent.token.revoke",
  "agent.update",
  "agent.update.fleet",
  "host.files.upload",
  "host.files.delete",
  "mcp.key.create",
  "mcp.key.revoke",
  "mcp.token.create",
  "mcp.token.revoke",
] as const;

describe("PDMUX audit boundary", () => {
  it("[TC-PDHOST-010] assigns stable audit actions to every fleet mutation", () => {
    for (const action of MUTATION_AUDIT_ACTIONS) {
      expect(source).toContain(`\"${action}\"`);
      expect(action).toMatch(/^[a-z]+(?:\.[a-z]+)+$/);
    }

    const auditTargets = source.match(/recordRequest\([\s\S]*?\);/g)?.join("\n") ?? "";
    expect(auditTargets).not.toMatch(/tokenHash|plaintext|authorization/i);
  });
});

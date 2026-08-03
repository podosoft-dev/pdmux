import { beforeEach, describe, expect, it } from "@jest/globals";
import "reflect-metadata";

import { AppException } from "../common/app-exception";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { HostMcpKey } from "./host-mcp-key.entity";
import {
  MCP_KEY_PREFIX,
  looksLikeMcpKey,
  maskMcpKey,
  mintMcpKey,
  type McpKeyScope,
} from "./host-mcp-key.crypto";
import { HostMcpKeysService } from "./host-mcp-keys.service";

const ORG_A = "org-a";
const ORG_B = "org-b";

function context() {
  const hostRepo = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRepo = new FakeRepository<HostService>();
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const gitRootRepo = new FakeRepository<HostGitRoot>();
  const hosts = new HostsService(hostRepo.asRepository(), serviceRepo.asRepository(), gitRootRepo.asRepository(), settings, fakeAgentReleases(), fakeDataSource());
  const keyRows = new FakeRepository<HostMcpKey>({
    lastUsedAt: null,
    revokedAt: null,
    createdByUserId: null,
    createdAt: new Date(),
  });
  const keys = new HostMcpKeysService(keyRows.asRepository(), hosts);
  return { hosts, keys, keyRows };
}

const mintInput = {
  label: "my laptop",
  expiresInDays: 90 as const,
  scopes: ["read", "write"] as McpKeyScope[],
};

describe("[TC-PDMCP-050] the key is shown once and stored as a hash", () => {
  let ctx: ReturnType<typeof context>;
  beforeEach(() => {
    ctx = context();
  });

  it("[TC-PDMCP-050] returns the plaintext exactly once, and never stores it", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.keys.mint(ORG_A, host.id, { ...mintInput, scopes: ["read", "write"] as McpKeyScope[] }, "user-1");

    expect(minted.key.startsWith(MCP_KEY_PREFIX)).toBe(true);
    // The row keeps a digest and a display prefix — nothing that reproduces the key.
    const stored = ctx.keyRows.rows[0];
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(minted.key);
    expect(stored?.keyHash).not.toBe(minted.key);
    expect(minted.key.startsWith(minted.keyPrefix)).toBe(true);

    // ...and no later read can produce it again.
    const listed = await ctx.keys.list(ORG_A, host.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(minted.key);
    expect(Object.keys(listed[0] ?? {})).not.toContain("key");
  });

  it("[TC-PDMCP-050] carries a prefix that says which credential leaked", () => {
    // Three secrets travel in this product and a paste of any of them has to be
    // recognisable on sight, because the answer ("revoke what?") differs.
    const minted = mintMcpKey();
    expect(minted.key.startsWith("pdmux_mcp_")).toBe(true);
    expect(looksLikeMcpKey(minted.key)).toBe(true);
    // An agent token must not be mistaken for one of these, in either direction.
    expect(looksLikeMcpKey("pdmux_abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(looksLikeMcpKey("pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW")).toBe(false);
    expect(looksLikeMcpKey(MCP_KEY_PREFIX)).toBe(false);
    expect(maskMcpKey(minted.key)).not.toContain(minted.key.slice(10, 30));
  });
});

describe("[TC-PDMCP-051] a key reaches its own host and nothing else", () => {
  let ctx: ReturnType<typeof context>;
  beforeEach(() => {
    ctx = context();
  });

  it("[TC-PDMCP-051] resolves to the host it was minted for", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.keys.mint(ORG_A, host.id, { ...mintInput, scopes: ["read"] as McpKeyScope[] }, null);

    const identity = await ctx.keys.authenticate(minted.key);
    expect(identity).toEqual({
      keyId: minted.id,
      hostId: host.id,
      organizationId: ORG_A,
      // Read-only survives the round trip — it is what makes run_command refuse.
      scopes: ["read"],
    });
  });

  it("[TC-PDMCP-051] cannot be minted or listed for a host in another scope", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    // 404, not 403: 403 would confirm the id exists.
    await expect(ctx.keys.mint(ORG_B, host.id, mintInput, null)).rejects.toBeInstanceOf(AppException);
    await expect(ctx.keys.list(ORG_B, host.id)).rejects.toBeInstanceOf(AppException);
  });

  it("[TC-PDMCP-051] stops working the moment it is revoked", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.keys.mint(ORG_A, host.id, mintInput, null);
    expect(await ctx.keys.authenticate(minted.key)).not.toBeNull();

    const revoked = await ctx.keys.revoke(ORG_A, host.id, minted.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(await ctx.keys.authenticate(minted.key)).toBeNull();

    // Revoking twice must not move the evidence of when access actually ended.
    const again = await ctx.keys.revoke(ORG_A, host.id, minted.id);
    expect(again.revokedAt).toBe(revoked.revokedAt);
  });

  it("[TC-PDMCP-051] stops working when it expires, without anybody revoking it", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    const minted = await ctx.keys.mint(ORG_A, host.id, mintInput, null);
    const row = ctx.keyRows.rows[0];
    expect(row).toBeDefined();
    if (row) row.expiresAt = new Date(Date.now() - 1000);

    expect(await ctx.keys.authenticate(minted.key)).toBeNull();
  });

  it("[TC-PDMCP-051] refuses a credential that is not one of ours, and says nothing about why", async () => {
    const host = await ctx.hosts.create(ORG_A, { label: "build-01" });
    await ctx.keys.mint(ORG_A, host.id, mintInput, null);
    // Unknown, wrong-shaped, and another product's secret all answer the same:
    // telling them apart tells an attacker which guesses were once real.
    for (const candidate of ["", "pdmux_notmine", `${MCP_KEY_PREFIX}wrong-but-long-enough-to-pass`, "Bearer x"]) {
      expect(await ctx.keys.authenticate(candidate)).toBeNull();
    }
  });
});

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { FleetSetting } from "../fleet/fleet-setting.entity";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostGitRoot } from "../hosts/host-git-root.entity";
import { HostService } from "../hosts/host-service.entity";
import { HostServicesService } from "../hosts/host-services.service";
import { Host } from "../hosts/host.entity";
import { HostsService } from "../hosts/hosts.service";
import { fakeAgentReleases } from "../testing/fake-agent-releases";
import { fakeDataSource } from "../testing/fake-data-source";
import { FakeRepository } from "../testing/fake-repository";
import { CloudflareClient } from "./cloudflare.client";
import { CloudflareService } from "./cloudflare.service";
import { HostConnector } from "./host-connector.entity";
import { IntegrationConnection } from "./integration-connection.entity";
import { ServiceExposure } from "./service-exposure.entity";

const ORG = "org-a";
const API_TOKEN = "cloudflare-api-token-for-test";

function ok(result: unknown): Response {
  return Response.json({ success: true, result });
}

function build(): {
  cloudflare: CloudflareService;
  hosts: HostsService;
  services: HostServicesService;
  serviceRows: FakeRepository<HostService>;
  calls: Array<{ method: string; path: string; body: unknown }>;
  failNext: (predicate: (method: string, path: string) => boolean) => void;
} {
  const hostRows = new FakeRepository<Host>({ tags: [], capabilities: [], sortOrder: 0, enabled: true });
  const serviceRows = new FakeRepository<HostService>({
    sortOrder: 0,
    probe: "http",
    path: "/",
    enabled: true,
  });
  const settings = new FleetSettingsService(new FakeRepository<FleetSetting>().asRepository());
  const hosts = new HostsService(
    hostRows.asRepository(),
    serviceRows.asRepository(),
    new FakeRepository<HostGitRoot>().asRepository(),
    settings,
    fakeAgentReleases(),
    fakeDataSource(),
  );
  const services = new HostServicesService(serviceRows.asRepository(), hosts);
  const connections = new FakeRepository<IntegrationConnection>({
    enabled: true,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  });
  const connectors = new FakeRepository<HostConnector>({
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  });
  const exposures = new FakeRepository<ServiceExposure>({
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  });
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const nextFailures: Array<(method: string, path: string) => boolean> = [];
  const requestFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
    calls.push({ method, path, body });
    const failureIndex = nextFailures.findIndex((predicate) => predicate(method, path));
    if (failureIndex >= 0) {
      nextFailures.splice(failureIndex, 1);
      return Response.json({ success: false, errors: [{ code: 1 }] }, { status: 502 });
    }
    if (url.pathname === "/client/v4/zones") {
      return ok([{ id: "zone-1", name: "example.com", account: { id: "account-1", name: "Example" } }]);
    }
    if (url.pathname.endsWith("/access/policies")) {
      return ok([{ id: "policy-1", name: "Team members" }]);
    }
    if (url.pathname.endsWith("/cfd_tunnel") && method === "POST") {
      return ok({ id: "tunnel-1", token: "cloudflare-tunnel-token-for-test" });
    }
    if (url.pathname.endsWith("/access/apps") && method === "POST") return ok({ id: "app-1" });
    if (url.pathname.endsWith("/dns_records") && method === "POST") return ok({ id: "dns-1" });
    return ok({});
  };
  const cloudflare = new CloudflareService(
    connections.asRepository(),
    connectors.asRepository(),
    exposures.asRepository(),
    hosts,
    services,
    (token) => {
      expect(token).toBe(API_TOKEN);
      return new CloudflareClient(token, requestFetch as typeof fetch);
    },
  );
  cloudflare.connect();
  return {
    cloudflare,
    hosts,
    services,
    serviceRows,
    calls,
    failNext: (predicate) => {
      nextFailures.push(predicate);
    },
  };
}

async function connectedService(ctx: ReturnType<typeof build>): Promise<{ host: Host; service: HostService }> {
  await ctx.cloudflare.put(ORG, {
    apiToken: API_TOKEN,
    zoneId: "zone-1",
    baseDomain: "apps.example.com",
    accessPolicyId: "policy-1",
  });
  const host = await ctx.hosts.create(ORG, { label: "Build 01" });
  await ctx.hosts.applyHello(host.id, {
    protocolVersion: 1,
    agentVersion: "0.11.5",
    hostname: "build-01",
    address: "127.0.0.1",
    os: "linux",
    arch: "amd64",
    capabilities: [],
    update: { canRestart: true, restartMode: "systemd" },
    connectors: { cloudflared: true },
  });
  const service = await ctx.services.create(ORG, host.id, { label: "Admin", port: 4173, probe: "http" });
  return { host, service };
}

describe("CloudflareService", () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "cloudflare-service-test-secret-at-least-32-chars";
    ctx = build();
  });

  it("[TC-PDEXTERNAL-001] validates and stores a fleet connection without returning the token", async () => {
    const view = await ctx.cloudflare.put(ORG, {
      apiToken: API_TOKEN,
      zoneId: "zone-1",
      baseDomain: "apps.example.com",
      accessPolicyId: "policy-1",
    });
    expect(view).toMatchObject({
      connected: true,
      tokenConfigured: true,
      accountId: "account-1",
      zoneName: "example.com",
      baseDomain: "apps.example.com",
      accessPolicyName: "Team members",
    });
    expect(JSON.stringify(view)).not.toContain(API_TOKEN);
  });

  it("[TC-PDEXTERNAL-002] provisions Access then ingress then DNS and tears DNS down first", async () => {
    const { host, service } = await connectedService(ctx);
    const exposure = await ctx.cloudflare.createExposure(ORG, host.id, service.id, {
      hostname: "admin-build-01.apps.example.com",
      mode: "access",
      originScheme: "http",
    });
    expect(exposure).toMatchObject({ status: "protected", url: "https://admin-build-01.apps.example.com" });
    const provision = ctx.calls.slice(-4).map((call) => `${call.method} ${call.path}`);
    expect(provision[0]).toContain("POST /client/v4/accounts/account-1/cfd_tunnel");
    expect(provision[1]).toContain("POST /client/v4/accounts/account-1/access/apps");
    expect(provision[2]).toContain("PUT /client/v4/accounts/account-1/cfd_tunnel/tunnel-1/configurations");
    expect(provision[3]).toContain("POST /client/v4/zones/zone-1/dns_records");
    expect(ctx.calls.at(-2)?.body).toMatchObject({
      config: {
        ingress: [
          { hostname: "admin-build-01.apps.example.com", service: "http://127.0.0.1:4173" },
          { service: "http_status:404" },
        ],
      },
    });
    expect(await ctx.cloudflare.agentConnector(host.id)).toMatchObject({
      enabled: true,
      token: "cloudflare-tunnel-token-for-test",
    });

    await ctx.cloudflare.removeExposure(ORG, host.id, service.id, exposure.id);
    const teardown = ctx.calls.slice(-4).map((call) => `${call.method} ${call.path}`);
    expect(teardown[0]).toContain("DELETE /client/v4/zones/zone-1/dns_records/dns-1");
    expect(teardown.at(-1)).toContain("DELETE /client/v4/accounts/account-1/cfd_tunnel/tunnel-1");
  });

  it("[TC-PDEXTERNAL-003] refuses public exposure without an explicit confirmation", async () => {
    const { host, service } = await connectedService(ctx);
    await expect(ctx.cloudflare.createExposure(ORG, host.id, service.id, {
      hostname: "admin-build-01.apps.example.com",
      mode: "public",
      originScheme: "http",
    })).rejects.toMatchObject({ code: "PUBLIC_EXPOSURE_CONFIRMATION_REQUIRED" });
  });

  it("[TC-PDEXTERNAL-004] retains local service state when final tunnel cleanup fails", async () => {
    const { host, service } = await connectedService(ctx);
    await ctx.cloudflare.createExposure(ORG, host.id, service.id, {
      hostname: "admin-build-01.apps.example.com",
      mode: "access",
      originScheme: "http",
    });
    ctx.failNext((method, path) => method === "DELETE" && path.includes("/cfd_tunnel/tunnel-1"));

    await expect(ctx.services.remove(ORG, host.id, service.id)).rejects.toMatchObject({
      code: "CLOUDFLARE_REQUEST_FAILED",
    });
    expect((await ctx.services.get(ORG, host.id, service.id)).id).toBe(service.id);
    expect(await ctx.cloudflare.listForHost(ORG, host.id)).toHaveLength(1);

    await ctx.services.remove(ORG, host.id, service.id);
    await expect(ctx.services.get(ORG, host.id, service.id)).rejects.toMatchObject({
      code: "HOST_SERVICE_NOT_FOUND",
    });
  });

  it("[TC-PDEXTERNAL-005] restores the original route when an exposure update fails", async () => {
    const { host, service } = await connectedService(ctx);
    const exposure = await ctx.cloudflare.createExposure(ORG, host.id, service.id, {
      hostname: "admin-build-01.apps.example.com",
      mode: "access",
      originScheme: "http",
    });
    ctx.failNext((method, path) => method === "POST" && path.endsWith("/dns_records"));

    await expect(ctx.cloudflare.updateExposure(ORG, host.id, service.id, exposure.id, {
      hostname: "admin-new.apps.example.com",
      mode: "access",
      originScheme: "https",
    })).rejects.toMatchObject({ code: "CLOUDFLARE_REQUEST_FAILED" });

    expect(await ctx.cloudflare.listForHost(ORG, host.id)).toMatchObject([{
      hostname: "admin-build-01.apps.example.com",
      mode: "access",
      originScheme: "http",
    }]);
    const ingressBodies = ctx.calls
      .filter((call) => call.method === "PUT" && call.path.endsWith("/configurations"))
      .map((call) => call.body);
    expect(ingressBodies.at(-1)).toMatchObject({
      config: {
        ingress: [
          { hostname: "admin-build-01.apps.example.com", service: "http://127.0.0.1:4173" },
          { service: "http_status:404" },
        ],
      },
    });
  });

  it("[TC-PDEXTERNAL-006] refuses a host whose connected agent cannot run managed connectors", async () => {
    await ctx.cloudflare.put(ORG, {
      apiToken: API_TOKEN,
      zoneId: "zone-1",
      baseDomain: "apps.example.com",
      accessPolicyId: "policy-1",
    });
    const host = await ctx.hosts.create(ORG, { label: "Legacy host" });
    const service = await ctx.services.create(ORG, host.id, { label: "Admin", port: 4173, probe: "http" });
    const callsBefore = ctx.calls.length;

    await expect(ctx.cloudflare.createExposure(ORG, host.id, service.id, {
      hostname: "admin-legacy.apps.example.com",
      mode: "access",
      originScheme: "http",
    })).rejects.toMatchObject({ code: "CLOUDFLARED_AGENT_REQUIRED" });
    expect(ctx.calls).toHaveLength(callsBefore);
  });

  it("[TC-PDEXTERNAL-007] refuses a host move while provider-owned resources are active", async () => {
    const { host, service } = await connectedService(ctx);
    await ctx.cloudflare.createExposure(ORG, host.id, service.id, {
      hostname: "admin-build-01.apps.example.com",
      mode: "access",
      originScheme: "http",
    });

    await expect(ctx.hosts.move(ORG, host.id, "other@example.com")).rejects.toMatchObject({
      code: "HOST_EXTERNAL_ACCESS_ACTIVE",
    });
    expect((await ctx.hosts.get(ORG, host.id)).organizationId).toBe(ORG);
  });

  it("[TC-PDEXTERNAL-008] keeps a published ingress synchronized with service port changes", async () => {
    const { host, service } = await connectedService(ctx);
    await ctx.cloudflare.createExposure(ORG, host.id, service.id, {
      hostname: "admin-build-01.apps.example.com",
      mode: "access",
      originScheme: "http",
    });

    await ctx.services.update(ORG, host.id, service.id, { port: 5000 });
    const ingressBodies = ctx.calls
      .filter((call) => call.method === "PUT" && call.path.endsWith("/configurations"))
      .map((call) => call.body);
    expect(ingressBodies.at(-1)).toMatchObject({
      config: {
        ingress: [
          { hostname: "admin-build-01.apps.example.com", service: "http://127.0.0.1:5000" },
          { service: "http_status:404" },
        ],
      },
    });

    ctx.failNext((method, path) => method === "PUT" && path.endsWith("/configurations"));
    await expect(ctx.services.update(ORG, host.id, service.id, { port: 6000 })).rejects.toMatchObject({
      code: "CLOUDFLARE_REQUEST_FAILED",
    });
    expect((await ctx.services.get(ORG, host.id, service.id)).port).toBe(5000);

    const save = spyOn(ctx.serviceRows, "save");
    save.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(ctx.services.update(ORG, host.id, service.id, { port: 7000 })).rejects.toThrow("database unavailable");
    expect((await ctx.services.get(ORG, host.id, service.id)).port).toBe(5000);
    expect(ctx.calls
      .filter((call) => call.method === "PUT" && call.path.endsWith("/configurations"))
      .at(-1)?.body).toMatchObject({
      config: {
        ingress: [
          { hostname: "admin-build-01.apps.example.com", service: "http://127.0.0.1:5000" },
          { service: "http_status:404" },
        ],
      },
    });
  });

  it("[TC-PDEXTERNAL-009] retains identifiers when compensating provider cleanup fails", async () => {
    const { host, service } = await connectedService(ctx);
    ctx.failNext((method, path) => method === "PUT" && path.endsWith("/configurations"));
    ctx.failNext((method, path) => method === "DELETE" && path.endsWith("/access/apps/app-1"));

    await expect(ctx.cloudflare.createExposure(ORG, host.id, service.id, {
      hostname: "admin-build-01.apps.example.com",
      mode: "access",
      originScheme: "http",
    })).rejects.toMatchObject({ code: "CLOUDFLARE_REQUEST_FAILED" });

    const retained = await ctx.cloudflare.listForHost(ORG, host.id);
    expect(retained).toMatchObject([{
      serviceId: service.id,
      status: "error",
      errorCode: "CLOUDFLARE_CLEANUP_REQUIRED",
    }]);
    await ctx.cloudflare.removeExposure(ORG, host.id, service.id, retained[0]!.id);
    expect(await ctx.cloudflare.listForHost(ORG, host.id)).toEqual([]);
  });
});

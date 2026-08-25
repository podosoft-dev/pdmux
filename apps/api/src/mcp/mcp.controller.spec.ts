import { describe, expect, it, mock } from "bun:test";
import { AppException } from "@podosoft/podokit-contracts";
import type { AgentEnrollmentsService } from "../agents/agent-enrollments.service";
import type { AgentExecService } from "../agents/agent-exec.service";
import type { AgentUpdateService } from "../agents/agent-update.service";
import type { FleetSettingsService } from "../fleet/fleet-settings.service";
import type { GitService } from "../git/git.service";
import type { HostsService } from "../hosts/hosts.service";
import type { HostServicesService } from "../hosts/host-services.service";
import type { MetricsService } from "../metrics/metrics.service";
import type { McpAuthService } from "./mcp-auth.service";
import { McpController } from "./mcp.controller";

function controller(
  enabled: boolean,
  authenticate = mock(async (_key: string): Promise<never> => null as never),
): McpController {
  return new McpController(
    { authenticate } as unknown as McpAuthService,
    {} as HostsService,
    {} as FleetSettingsService,
    {} as HostServicesService,
    {} as MetricsService,
    {} as GitService,
    {} as AgentEnrollmentsService,
    {} as AgentExecService,
    {} as AgentUpdateService,
    async () => enabled,
  );
}

describe("MCP request boundary", () => {
  it("[TC-PDMCP-060] rejects a cross-origin browser before reading its credential", async () => {
    const authenticate = mock(async (_key: string): Promise<never> => null as never);
    const request = new Request("https://pdmux.example.com/mcp", {
      method: "POST",
      headers: {
        origin: "https://other.example.com",
        authorization: "Bearer secret",
      },
    });

    await expect(controller(true, authenticate).handle(request)).rejects.toMatchObject({
      code: "MCP_ORIGIN_NOT_ALLOWED",
      statusCode: 403,
    } satisfies Partial<AppException>);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("returns 404 for every credential while the server policy is disabled", async () => {
    const authenticate = mock(async (_key: string): Promise<never> => null as never);
    const response = await controller(false, authenticate).handle(new Request("https://pdmux.example.com/mcp", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: -32000 } });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("[TC-PDMCP-060] requests a bearer credential when the server policy is enabled", async () => {
    const authenticate = mock(async (_key: string): Promise<never> => null as never);
    const response = await controller(true, authenticate).handle(
      new Request("https://pdmux.example.com/mcp", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="pdmux-mcp"');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("[TC-PDMCP-060] rejects non-POST stateless requests after authenticating the caller", async () => {
    const authenticate = mock(async () => ({
      kind: "host" as const,
      identity: {
        keyId: "key-1",
        hostId: "11111111-1111-4111-8111-111111111111",
        organizationId: "org-1",
        scopes: ["read" as const],
      },
    }));
    const response = await controller(true, authenticate as never).handle(new Request("https://pdmux.example.com/mcp", {
      method: "GET",
      headers: { authorization: "Bearer secret" },
    }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(authenticate).toHaveBeenCalledWith("secret");
  });
});

import { All, Controller, ForbiddenException, Req, Res, UnauthorizedException } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Public } from "@thallesp/nestjs-better-auth";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPdmuxMcpServer } from "@pdmux/mcp";
import type { Request, Response } from "express";

import { AgentEnrollmentsService } from "../agents/agent-enrollments.service";
import { AgentExecService } from "../agents/agent-exec.service";
import { GitService } from "../git/git.service";
import { HostServicesService } from "../hosts/host-services.service";
import { HostsService } from "../hosts/hosts.service";
import { MetricsService } from "../metrics/metrics.service";
import { ApiHostGateway } from "./host-gateway";
import { HostMcpKeysService } from "./host-mcp-keys.service";

/**
 * The endpoint a coding CLI on a host connects to.
 *
 * ⚠ STATELESS ON PURPOSE. A server and a transport are built per request and
 * closed when the response closes (`sessionIdGenerator: undefined`), so there is
 * no session store to grow, to expire, or to make routing sticky. The cost is
 * rebuilding a tool list per call; the benefit is that a restart loses nothing
 * and a second replica needs no coordination.
 *
 * ⚠ THE ORDER OF THE CHECKS IS THE CONTRACT, not a style choice. `Origin` is
 * validated BEFORE the credential is read: a browser on another site can be made
 * to POST here (DNS rebinding against a private address is the case that matters
 * for a self-hosted install), and reading the key first would make the response
 * time depend on whether the key was real. There is a unit test for the ordering,
 * because it is exactly the kind of thing a later refactor tidies away.
 */
@ApiExcludeController()
@Controller("mcp")
@Public()
export class McpController {
  constructor(
    private readonly keys: HostMcpKeysService,
    private readonly hosts: HostsService,
    private readonly hostServices: HostServicesService,
    private readonly metrics: MetricsService,
    private readonly git: GitService,
    private readonly enrollments: AgentEnrollmentsService,
    private readonly exec: AgentExecService,
  ) {}

  @All()
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    this.assertOrigin(request);

    const presented = McpController.bearer(request);
    const identity = presented ? await this.keys.authenticate(presented) : null;
    if (!identity) {
      // The header is what an MCP client reads to know it should send a key at all.
      response.setHeader("www-authenticate", 'Bearer realm="pdmux-mcp"');
      throw new UnauthorizedException("Invalid or missing pdmux MCP key");
    }

    if (request.method !== "POST") {
      // Stateless Streamable HTTP has no stream to resume and no session to
      // delete, so GET and DELETE have nothing to do. Saying so beats a silent 404.
      response.setHeader("allow", "POST");
      response.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Stateless MCP accepts POST requests only" },
        id: null,
      });
      return;
    }

    const host = await this.hosts.get(identity.organizationId, identity.hostId);
    const gateway = new ApiHostGateway(identity, {
      hosts: this.hosts,
      hostServices: this.hostServices,
      metrics: this.metrics,
      git: this.git,
      enrollments: this.enrollments,
      exec: this.exec,
      origin: McpController.publicOrigin(request),
    });
    const server = createPdmuxMcpServer(gateway, {
      hostLabel: host.label,
      canRun: identity.scopes.includes("write"),
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  }

  /**
   * A cross-origin browser must not reach this, and the check runs before any
   * credential is touched.
   *
   * No `Origin` at all is a non-browser client (a CLI, curl), which is the normal
   * case here — it is the presence of a MISMATCHED one that is the attack.
   */
  private assertOrigin(request: Request): void {
    const origin = request.header("origin");
    if (!origin) return;
    const expected = request.header("x-forwarded-host") ?? request.header("host");
    try {
      if (!expected || new URL(origin).host !== expected) {
        throw new ForbiddenException("MCP origin is not allowed");
      }
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      // An unparseable Origin is not a same-origin request.
      throw new ForbiddenException("MCP origin is not allowed");
    }
  }

  private static bearer(request: Request): string | null {
    const header = request.header("authorization");
    if (!header?.startsWith("Bearer ")) return null;
    const value = header.slice("Bearer ".length).trim();
    return value.length > 0 ? value : null;
  }

  /**
   * The origin a caller can actually reach, rebuilt from the proxy's headers.
   *
   * The install command this hands back is run on another machine, so it must
   * carry the PUBLIC origin — `host` alone would emit the container's own name
   * behind a reverse proxy, and the one-liner would fail on the target.
   */
  private static publicOrigin(request: Request): string {
    const protocol = request.header("x-forwarded-proto") ?? request.protocol;
    const host = request.header("x-forwarded-host") ?? request.header("host") ?? "";
    return `${protocol}://${host}`;
  }
}

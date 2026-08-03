import { All, Controller, ForbiddenException, Req, Res, UnauthorizedException } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Public } from "@thallesp/nestjs-better-auth";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPdmuxMcpServer } from "@pdmux/mcp";
import type { Request, Response } from "express";

import { AgentEnrollmentsService } from "../agents/agent-enrollments.service";
import { AgentExecService } from "../agents/agent-exec.service";
import { AgentUpdateService } from "../agents/agent-update.service";
import { GitService } from "../git/git.service";
import { HostServicesService } from "../hosts/host-services.service";
import { FleetSettingsService } from "../fleet/fleet-settings.service";
import { HostsService } from "../hosts/hosts.service";
import { MetricsService } from "../metrics/metrics.service";
import { ApiFleetGateway } from "./fleet-gateway";
import { ApiHostGateway } from "./host-gateway";
import { recordAudit } from "../audit/audit-events";
import type { McpIdentity } from "./host-mcp-keys.service";
import { McpAuthService } from "./mcp-auth.service";
import { mcpEnabled } from "./mcp-enabled";
import type { McpUserIdentity } from "./user-mcp-keys.service";

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
 * time depend on whether the key was real.
 *
 * `mcp.controller.spec.ts` holds that order, and the assertion that does the work
 * is the negative one — a refused request must leave `keys.authenticate` UNCALLED.
 * Reordering this method still answers 403, so a status-code test would not notice.
 *
 * ⚠ That spec needs `@pdmux/mcp` mapped to `testing/pdmux-mcp.stub.ts` in this
 * package's jest config. The package is ESM and these tests run in jest's CommonJS
 * runtime, which is what kept this file untested for as long as it was.
 */
@ApiExcludeController()
@Controller("mcp")
@Public()
export class McpController {
  constructor(
    private readonly auth: McpAuthService,
    private readonly hosts: HostsService,
    private readonly fleetSettings: FleetSettingsService,
    private readonly hostServices: HostServicesService,
    private readonly metrics: MetricsService,
    private readonly git: GitService,
    private readonly enrollments: AgentEnrollmentsService,
    private readonly exec: AgentExecService,
    private readonly updates: AgentUpdateService,
  ) {}

  @All()
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    this.assertOrigin(request);

    // ⚠ THE INSTALLATION'S KILL SWITCH SITS HERE, ABOVE THE CREDENTIAL, because it
    // does not depend on one: a disabled endpoint must answer every caller the same
    // way. Putting it below would make "is MCP on" leak through response timing in
    // the same way reading the key first would.
    //
    // ⚠ 404, NOT 401 OR 403. A 401 with `www-authenticate` tells a client to present
    // a key, so it retries for ever and the operator reads "bad key" for something
    // that is not a key problem; 403 says "your credential is insufficient", which is
    // also false and invites retrying with a better one. `feature-gate.ts` answers a
    // disabled feature with 404 for the same reason.
    if (!(await mcpEnabled())) {
      response.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "MCP is disabled on this pdmux server" },
        id: null,
      });
      return;
    }

    const presented = McpController.bearer(request);
    const caller = presented ? await this.auth.authenticate(presented) : null;
    if (!caller) {
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

    // ⚠ THE PER-SCOPE SWITCH NEEDS THE CREDENTIAL, so it cannot move above it — the
    // scope comes from the token. Here, and only here, it is safe to be specific:
    // this caller has already PROVED a valid credential, so naming the reason costs
    // nothing. The blanket "tell nobody anything" rule is about credentials that did
    // not resolve.
    if (caller.kind === "user") {
      const allowed = (await this.fleetSettings.resolve(caller.identity.organizationId)).mcpUserTokens;
      if (!allowed) {
        response.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Fleet-wide MCP tokens are disabled for this fleet" },
          id: null,
        });
        return;
      }
    }

    // ⚠ THIS LOOKUP USED TO BE UNCONDITIONAL, purely to get `hostLabel`. A fleet
    // token has no single host, so it must stay inside this branch — running it for
    // one would 404 on a `hostId` that does not exist.
    const shared = {
      hosts: this.hosts,
      hostServices: this.hostServices,
      metrics: this.metrics,
      git: this.git,
      enrollments: this.enrollments,
      exec: this.exec,
      origin: McpController.publicOrigin(request),
    };

    let server;
    if (caller.kind === "host") {
      const identity = caller.identity;
      const host = await this.hosts.get(identity.organizationId, identity.hostId);
      server = createPdmuxMcpServer({
        mode: "host",
        gateway: new ApiHostGateway(identity, {
          ...shared,
          audit: (entry) =>
            this.recordHostToolAudit(request, identity, host.label, entry),
        }),
        hostLabel: host.label,
        canRun: identity.scopes.includes("write"),
      });
    } else {
      const identity = caller.identity;
      server = createPdmuxMcpServer({
        mode: "fleet",
        gateway: new ApiFleetGateway(identity, {
          ...shared,
          updates: this.updates,
          scopeLabel: identity.organizationId.startsWith("personal:") ? "your machines" : identity.organizationId,
          audit: (entry) => this.recordToolAudit(request, identity, entry),
        }),
        scopeLabel: identity.organizationId.startsWith("personal:") ? "your machines" : identity.organizationId,
        origin: McpController.publicOrigin(request),
        // ⚠ EFFECTIVE, never the stored tier — a demoted owner's token weakens here.
        tier: identity.effectiveTier,
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  }

  /**
   * One audit entry per MUTATING tool call.
   *
   * ⚠ `@Audit` CANNOT SERVE THIS ENDPOINT, which is why the entries are written by
   * hand. It is a controller-handler decorator and everything here arrives at one
   * `@All()`, so it could only ever record "mcp.call" with no idea which tool ran —
   * and `AuditInterceptor` derives the actor from `getSession()`, which returns
   * nothing for a bearer credential, so every entry would carry `actorId: null`.
   *
   * ⚠ READS ARE NOT AUDITED, deliberately. A model polling `host_detail` every two
   * seconds while an install finishes would bury the mutations this table exists to
   * record. `lastUsedAt` on the token already answers "was this credential used".
   *
   * ⚠ THE DRY-RUN BRANCH IS AUDITED TOO. "Somebody's agent tried to delete a host"
   * is precisely the line an operator wants and the one it is most tempting to skip.
   */
  /**
   * The host-mode half of the same trail.
   *
   * ⚠ `actorId` IS NULL AND THAT IS HONEST. A host key belongs to a machine's
   * connection, not to a person — nobody signed in — so the entry names the KEY
   * instead. An invented actor would be worse than an absent one.
   */
  private recordHostToolAudit(
    request: Request,
    identity: McpIdentity,
    hostLabel: string,
    entry: { tool: string; metadata?: Record<string, unknown> },
  ): void {
    void recordAudit({
      action: `mcp.tool.${entry.tool}`,
      actorId: null,
      targetType: "host",
      targetId: identity.hostId,
      targetLabel: hostLabel,
      ip: request.ip ?? null,
      metadata: { via: "mcp", mode: "host", keyId: identity.keyId, scopes: identity.scopes, ...entry.metadata },
    });
  }

  private recordToolAudit(
    request: Request,
    identity: McpUserIdentity,
    entry: { tool: string; target?: { type: string; id?: string; label?: string }; metadata?: Record<string, unknown> },
  ): void {
    void recordAudit({
      action: `mcp.tool.${entry.tool}`,
      actorId: identity.userId,
      targetType: entry.target?.type ?? null,
      targetId: entry.target?.id ?? null,
      targetLabel: entry.target?.label ?? null,
      ip: request.ip ?? null,
      metadata: {
        via: "mcp",
        tokenId: identity.keyId,
        tier: identity.tier,
        effectiveTier: identity.effectiveTier,
        ...entry.metadata,
      },
    });
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

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AgentsModule } from "../agents/agents.module";
import { FleetModule } from "../fleet/fleet.module";
import { GitModule } from "../git/git.module";
import { HostsModule } from "../hosts/hosts.module";
import { MetricsModule } from "../metrics/metrics.module";
import { AgentKitController } from "./agent-kit.controller";
import { HostMcpKey } from "./host-mcp-key.entity";
import { HostMcpKeysController } from "./host-mcp-keys.controller";
import { HostMcpKeysService } from "./host-mcp-keys.service";
import { McpAuthService } from "./mcp-auth.service";
import { McpAuthorityService } from "./mcp-authority.service";
import { McpController } from "./mcp.controller";
import { UserMcpKey } from "./user-mcp-key.entity";
import { UserMcpKeysService } from "./user-mcp-keys.service";
import { UserMcpTokensController } from "./user-mcp-tokens.controller";

/**
 * The MCP surface: the two credentials a coding CLI can hold, and the endpoint they
 * speak to.
 *
 * It imports `HostsModule` rather than the host repository so every lookup goes
 * through `HostsService.get(scope, id)` — the single gate that makes "there is no
 * scope-free read of a host" true. That gate matters MORE now than when it was
 * written: a fleet token names hosts explicitly, so what used to be "there is no
 * parameter through which a caller could name another machine" has become "the
 * parameter is checked", and this is where it is checked.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([HostMcpKey, UserMcpKey]),
    HostsModule,
    AgentsModule,
    // The per-scope switch for fleet tokens is a fleet setting, and the controller
    // reads it before serving one.
    FleetModule,
    MetricsModule,
    GitModule,
  ],
  controllers: [HostMcpKeysController, UserMcpTokensController, McpController, AgentKitController],
  providers: [HostMcpKeysService, UserMcpKeysService, McpAuthorityService, McpAuthService],
  exports: [HostMcpKeysService, UserMcpKeysService],
})
export class McpModule {}

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AgentsModule } from "../agents/agents.module";
import { GitModule } from "../git/git.module";
import { HostsModule } from "../hosts/hosts.module";
import { MetricsModule } from "../metrics/metrics.module";
import { AgentKitController } from "./agent-kit.controller";
import { HostMcpKey } from "./host-mcp-key.entity";
import { HostMcpKeysController } from "./host-mcp-keys.controller";
import { HostMcpKeysService } from "./host-mcp-keys.service";
import { McpController } from "./mcp.controller";

/**
 * The MCP surface: the credential a coding CLI holds, and (next) the endpoint it
 * speaks to.
 *
 * It imports `HostsModule` rather than the host repository so every lookup goes
 * through `HostsService.get(scope, id)` — the single gate that makes "there is no
 * scope-free read of a host" true.
 */
@Module({
  imports: [TypeOrmModule.forFeature([HostMcpKey]), HostsModule, AgentsModule, MetricsModule, GitModule],
  controllers: [HostMcpKeysController, McpController, AgentKitController],
  providers: [HostMcpKeysService],
  exports: [HostMcpKeysService],
})
export class McpModule {}

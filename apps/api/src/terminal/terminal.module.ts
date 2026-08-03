import { Module } from "@nestjs/common";
import { AgentsModule } from "../agents/agents.module";
import { FleetModule } from "../fleet/fleet.module";
import { HostsModule } from "../hosts/hosts.module";
import { TerminalGateway } from "./terminal.gateway";
import { TerminalRelayService } from "./terminal-relay.service";

/** Browser half of the terminal: session-authenticated socket + frame relay. */
@Module({
  imports: [HostsModule, FleetModule, AgentsModule],
  providers: [TerminalRelayService, TerminalGateway],
  exports: [TerminalRelayService],
})
export class TerminalModule {}

import { Module } from "@nestjs/common";
import { AgentsModule } from "../agents/agents.module";
import { FleetModule } from "../fleet/fleet.module";
import { HostsModule } from "../hosts/hosts.module";
import { TerminalGateway } from "./terminal.gateway";
import { TerminalMuxController } from "./terminal-mux.controller";
import { TerminalRelayService } from "./terminal-relay.service";

/** Browser half of the terminal: session-authenticated socket + frame relay, plus the
 *  one HTTP route that reaches a pane's scrollback (see `TerminalMuxController`). */
@Module({
  imports: [HostsModule, FleetModule, AgentsModule],
  controllers: [TerminalMuxController],
  providers: [TerminalRelayService, TerminalGateway],
  exports: [TerminalRelayService],
})
export class TerminalModule {}

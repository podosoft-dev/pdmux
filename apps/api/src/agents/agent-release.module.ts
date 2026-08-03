import { Module } from "@nestjs/common";
import {
  AGENT_RELEASE_SOURCE,
  AgentReleaseService,
  fileSystemAgentReleases,
} from "./agent-release.service";

/**
 * The published-release lookup, on its own so both sides can have it.
 *
 * The hosts module needs it to say whether a host is behind, and the agents
 * module needs it to fill in an `update` frame. `AgentsModule` already imports
 * `HostsModule`, so putting the provider in either one would either duplicate the
 * instance (and its cache) or create an import cycle. This module has no
 * dependencies of its own, so both can import it and share one.
 */
@Module({
  providers: [
    AgentReleaseService,
    // The filesystem reader is bound here rather than inside the service so a
    // spec supplies its own source without touching a disk.
    { provide: AGENT_RELEASE_SOURCE, useValue: fileSystemAgentReleases },
  ],
  exports: [AgentReleaseService],
})
export class AgentReleaseModule {}

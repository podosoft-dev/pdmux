import type { DynamicModule, Provider, Type } from "@nestjs/common";
import { AgentsModule } from "./agents/agents.module";
import { FleetModule } from "./fleet/fleet.module";
import { GitModule } from "./git/git.module";
import { HostsModule } from "./hosts/hosts.module";
import { McpModule } from "./mcp/mcp.module";
import { MetricsModule } from "./metrics/metrics.module";
import { PrefsModule } from "./prefs/prefs.module";
import { TerminalModule } from "./terminal/terminal.module";

// Owned extension slot for the Nest app. This file is yours — PodoKit never
// writes to it, so `podo update` leaves it alone. Use it to add your own modules
// or providers, or to override a PodoKit-provided provider without editing
// managed code. Because these are spread in *after* the module-wired providers,
// an override here takes precedence.
//
// Example — swap the mailer transport for your own implementation:
//   import { Mailer } from "./mailer/mailer";
//   import { MyMailer } from "./my-mailer";
//   export const extensionProviders: Provider[] = [
//     { provide: Mailer, useClass: MyMailer },
//   ];

/** Extra modules to import into AppModule (or DynamicModule overrides). */
export const extensionImports: (Type | DynamicModule)[] = [
  // pdmux domain: hosts and their services, agent tokens + gateway, resource
  // history, read-only git snapshots, terminal relay, per-user personalisation,
  // org settings, and the MCP surface a coding CLI connects to.
  FleetModule,
  HostsModule,
  MetricsModule,
  GitModule,
  AgentsModule,
  TerminalModule,
  PrefsModule,
  McpModule,
];

/** Extra or overriding providers for AppModule. Same-token providers listed here
 *  win over the ones PodoKit modules registered. */
export const extensionProviders: Provider[] = [];

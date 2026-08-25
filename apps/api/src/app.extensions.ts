import type { PodokitModule, ServiceRegistry } from "./core/services";
import { pdmuxModule } from "./pdmux/pdmux.module";

// This owned extension slot is never overwritten by `podo update`. Register
// application services during startup and add Elysia plugins without editing
// managed PodoKit files. The registry is frozen before the server starts, so
// service resolution never occurs on the request hot path.

export function configureServices(_services: ServiceRegistry): void {}

export const extensionModules: PodokitModule[] = [pdmuxModule];

import { desktopModule } from "./desktop/desktop.module";
import { initializeDesktopRuntime } from "./desktop/local-auth";
import { SETTINGS } from "./auth/auth.module";
import { RATE_LIMIT_ROUTES } from "@podosoft/podokit-runtime";
import type { PodokitModule, ServiceRegistry } from "./core/services";
import { FILE_TRANSFER_BUDGET } from "./file-transfers/file-transfer-budget";
import { pdmuxModule } from "./pdmux/pdmux.module";

// This owned extension slot is never overwritten by `podo update`. Register
// application services during startup and add Elysia plugins without editing
// managed PodoKit files. The registry is frozen before the server starts, so
// service resolution never occurs on the request hot path.

export function configureServices(services: ServiceRegistry): void {
  services.onStart(() => initializeDesktopRuntime(async () => {
    await services.resolve(SETTINGS).setMany({ require2fa: false });
  }));
  services.tryResolve(RATE_LIMIT_ROUTES)?.register(FILE_TRANSFER_BUDGET);
}

export const extensionModules: PodokitModule[] = [pdmuxModule, desktopModule];

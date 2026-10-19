import { DESKTOP_HTTP_ROUTES } from "../desktop/desktop.module";
import { PDMUX_DOCUMENTED_HTTP_ROUTES } from "../pdmux/pdmux.contract";
import { VM_DOCUMENTED_HTTP_ROUTES } from "../vm/vm.contract";

// This owned file is never overwritten by `podo update`. List the operations
// the application's own API must serve, as "METHOD /path". `bun run contract`
// fails when one is not registered or missing from the OpenAPI document, for
// example after a route was renamed or hidden by mistake. Parameters may use
// either syntax: "GET /reports/{id}" or "GET /reports/:id".
export const APP_DOCUMENTED_ROUTES: readonly string[] = [...PDMUX_DOCUMENTED_HTTP_ROUTES, ...DESKTOP_HTTP_ROUTES, ...VM_DOCUMENTED_HTTP_ROUTES];

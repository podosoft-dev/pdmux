import { Elysia } from "elysia";
import { ACCESS_POLICY, type PodokitModule } from "../../core/services";

export const adminModule: PodokitModule = {
  name: "desktop-site",
  configure: (_env, services): void => { services.resolve(ACCESS_POLICY).register("GET", "/site/settings", "public"); },
  plugin: () => new Elysia({ name: "desktop.site" })
    .get("/site/settings", () => ({ name: "PDMux", allowSignup: "false", maintenanceMode: "false", hasFavicon: false })),
};

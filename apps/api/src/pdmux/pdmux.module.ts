import { AGENT_WS_PATH, TERMINAL_WS_PATH } from "@pdmux/protocol";
import { Elysia } from "elysia";
import { ACCESS_POLICY, type PodokitModule } from "../core/services";
import { pdmuxHttpPlugin } from "./pdmux.http";
import { createPdmuxServices } from "./pdmux.services";
import { PdmuxGateway } from "./pdmux.gateway";
import { PDMUX_GATEWAY, pdmuxWsPlugin } from "./pdmux.ws";

export const pdmuxModule: PodokitModule = {
  name: "pdmux",
  configure: (_env, services): void => {
    const pdmux = createPdmuxServices(services);
    const gateway = new PdmuxGateway(pdmux);
    services.register(PDMUX_GATEWAY, gateway, () => gateway.close());
    services.onStart(() => gateway.start());
    const access = services.resolve(ACCESS_POLICY);
    access.register("*", "/mcp", "public");
    access.register("POST", "/agent/enroll", "public");
    access.register("GET", "/agent-kit", "public");
    access.register("GET", "/agent-kit/manifest", "public");
    access.register("*", AGENT_WS_PATH, "public");
    access.register("*", TERMINAL_WS_PATH, "public");
  },
  plugin: (context) => new Elysia({ name: "pdmux" })
    .use(pdmuxHttpPlugin(context))
    .use(pdmuxWsPlugin(context)),
};

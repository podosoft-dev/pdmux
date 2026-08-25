import { describe, expect, it } from "bun:test";
import type { Elysia } from "elysia";
import type { AppContext } from "../core/services";
import { ServiceRegistry } from "../core/services";
import {
  PDMUX_DOCUMENTED_HTTP_ROUTES,
  PDMUX_HTTP_ROUTES,
  PDMUX_WEBSOCKET_ROUTES,
} from "./pdmux.contract";
import { PdmuxGateway } from "./pdmux.gateway";
import { pdmuxHttpPlugin } from "./pdmux.http";
import { PDMUX, type PdmuxServices } from "./pdmux.services";
import { createPdmuxWsPlugin } from "./pdmux.ws";

interface RouteEntry {
  method: string;
  path: string;
}

function routes(plugin: unknown): string[] {
  return ((plugin as Elysia).routes as RouteEntry[])
    .map((route) => `${route.method} ${route.path}`)
    .sort();
}

describe("PDMUX API contract inventory", () => {
  it("registers every documented HTTP endpoint exactly once", () => {
    const services = new ServiceRegistry();
    services.register(PDMUX, {} as PdmuxServices);
    const plugin = pdmuxHttpPlugin({ services } as AppContext);
    expect(routes(plugin)).toEqual([...PDMUX_HTTP_ROUTES].sort());
  });

  it("registers both native Bun WebSocket endpoints", () => {
    const gateway = new PdmuxGateway({} as PdmuxServices);
    const plugin = createPdmuxWsPlugin(gateway)({} as AppContext);
    expect(routes(plugin)).toEqual([...PDMUX_WEBSOCKET_ROUTES].sort());
  });

  it("keeps only intentionally hidden transport routes out of OpenAPI", () => {
    expect(PDMUX_DOCUMENTED_HTTP_ROUTES).toHaveLength(PDMUX_HTTP_ROUTES.length - 3);
    expect(PDMUX_DOCUMENTED_HTTP_ROUTES).toContain("GET /hosts/{hostId}");
    expect(PDMUX_DOCUMENTED_HTTP_ROUTES).not.toContain("ALL /mcp");
  });
});

import { describe, expect, it } from "@jest/globals";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import "reflect-metadata";
import { AgentEnrollController } from "../agents/agent-enroll.controller";
import { AgentEnrollmentsController } from "../agents/agent-enrollments.controller";
import { AgentTokensController } from "../agents/agent-tokens.controller";
import { AgentUpdateController, FleetAgentUpdateController } from "../agents/agent-update.controller";
import { AUDIT_KEY, type AuditMeta } from "../audit/audit.decorator";
import { FleetSettingsController } from "../fleet/fleet-settings.controller";
import { HostServicesController } from "./host-services.controller";
import { HostsController } from "./hosts.controller";

type Handler = (...args: unknown[]) => unknown;

const MUTATING = new Set<number>([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

/** Walk a controller's prototype and report every route handler it declares. */
function routes(controller: new (...args: never[]) => object): {
  name: string;
  method: number;
  audit: AuditMeta | undefined;
}[] {
  const prototype = controller.prototype as Record<string, Handler>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .map((name) => {
      const handler = prototype[name] as Handler;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      return {
        name: `${controller.name}.${name}`,
        method: method ?? -1,
        path,
        audit: Reflect.getMetadata(AUDIT_KEY, handler) as AuditMeta | undefined,
      };
    })
    .filter((route) => route.path !== undefined);
}

/**
 * The audit interceptor only records handlers marked with @Audit, so "did we
 * remember?" is a property of the code, not of a request. Asserting it here means
 * a new mutation cannot ship untracked — which is exactly how audit trails rot.
 */
describe("[TC-PDHOST-010] fleet mutations are audited", () => {
  const controllers = [
    HostsController,
    HostServicesController,
    AgentTokensController,
    AgentEnrollmentsController,
    AgentEnrollController,
    AgentUpdateController,
    FleetAgentUpdateController,
    FleetSettingsController,
  ];

  it("marks every mutating route with an @Audit action", () => {
    const unaudited: string[] = [];
    for (const controller of controllers) {
      for (const route of routes(controller)) {
        if (MUTATING.has(route.method) && !route.audit) unaudited.push(route.name);
      }
    }
    expect(unaudited).toEqual([]);
  });

  it("uses dotted, resource-scoped action codes", () => {
    const actions = controllers
      .flatMap((controller) => routes(controller))
      .filter((route) => route.audit)
      .map((route) => route.audit?.action ?? "");

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    expect(actions).toContain("host.create");
    expect(actions).toContain("agent.token.rotate");
  });

  it("never puts token or enrollment-code plaintext in the audit target", () => {
    // These hand back a secret in their response body, so their audit resolvers are
    // the place a plaintext leaks into a permanent log. `HostsController.create`
    // joined them when registering a host started returning a code with it — its
    // siblings are excluded because they answer with rows, not secrets.
    const secretRoutes = [AgentTokensController, AgentEnrollmentsController, AgentEnrollController]
      .flatMap((controller) => routes(controller))
      .concat(routes(HostsController).filter((route) => route.name === "HostsController.create"))
      .filter((route) => route.audit);

    expect(secretRoutes.length).toBeGreaterThan(0);
    for (const route of secretRoutes) {
      const target = route.audit?.resolve?.({} as never, {
        id: "row-id",
        name: "laptop",
        token: "pdmux_secret-value",
        code: "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW",
        masked: "pdmxe_…N5HVW",
        // The shape `POST /hosts` answers with: the code is one level down.
        enrollment: { id: "enrollment-id", code: "pdmxe_7Q4KM-9XZRB-8C3TF-N5HVW" },
      });
      const serialised = JSON.stringify(target ?? {});
      expect(serialised).not.toContain("pdmux_secret-value");
      expect(serialised).not.toContain("pdmxe_7Q4KM");
    }
  });

  it("records that host creation issued a code, and which row it is", () => {
    const create = routes(HostsController).find((route) => route.name === "HostsController.create");

    expect(create?.audit?.action).toBe("host.create");
    // An audit entry that only said "host created" would leave no trace of the
    // credential that came with it — including the case where none did.
    expect(create?.audit?.resolve?.({} as never, { id: "host-id", label: "build-01", enrollment: { id: "e-1" } })).toEqual(
      { type: "host", id: "host-id", label: "build-01", metadata: { enrollmentIssued: true, enrollmentId: "e-1" } },
    );
    expect(create?.audit?.resolve?.({} as never, { id: "host-id", label: "build-01", enrollment: null })).toEqual({
      type: "host",
      id: "host-id",
      label: "build-01",
      metadata: { enrollmentIssued: false, enrollmentId: null },
    });
  });
});

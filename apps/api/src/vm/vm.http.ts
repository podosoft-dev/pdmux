import { Elysia } from "elysia";
import type { AppPlugin } from "../core/services";
import { assertCanManageFleet, assertCanOperateHostPower, resolveScopeId } from "../fleet/session-scope";
import { dto } from "../common/dto";
import { audit, sessionFor } from "../pdmux/pdmux.http";
import { PDMUX } from "../pdmux/pdmux.services";
import { CreateVmDto, DeleteVmDto, LinkHostVmDto, PowerVmDto, UpdateVmProviderDto, VmProviderDto } from "./dto/vm.dto";
import { FORCED_VM_ACTIONS } from "./vm.contract";
import type { VmActor } from "./vm-operations.service";
import { PROVIDER_DEFAULTS } from "./vm-provider";
import { providerKinds, type VmProviderInput } from "./vm-providers.service";
import { VM } from "./vm.module-key";

/** A new connection: what the form left out takes the platform's default. */
function providerInput(input: VmProviderDto): VmProviderInput {
  const defaults = PROVIDER_DEFAULTS[input.kind];
  return {
    kind: input.kind,
    name: input.name ?? "",
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    tokenId: input.tokenId,
    tokenSecret: input.tokenSecret,
    caCertificate: input.caCertificate,
    defaultNode: input.defaultNode,
    defaultTemplate: input.defaultTemplateNode && input.defaultTemplateVmid
      ? { node: input.defaultTemplateNode, vmid: input.defaultTemplateVmid }
      : null,
    defaultStorage: input.defaultStorage,
    defaultPool: input.defaultPool,
    vmidMin: input.vmidMin ?? defaults.vmidMin,
    vmidMax: input.vmidMax ?? defaults.vmidMax,
    defaultCores: input.defaultCores ?? defaults.cores,
    defaultMemoryMb: input.defaultMemoryMb ?? defaults.memoryMb,
    defaultDiskGb: input.defaultDiskGb ?? defaults.diskGb,
    fullClone: input.fullClone ?? defaults.fullClone,
    sleepRequiresTag: input.sleepRequiresTag,
    backupBeforeSleep: input.backupBeforeSleep,
    enrollUrl: input.enrollUrl ? input.enrollUrl.replace(/\/+$/, "") : null,
  };
}

function providerPatch(input: UpdateVmProviderDto): Partial<VmProviderInput> {
  const patch: Partial<VmProviderInput> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl.replace(/\/+$/, "");
  if (input.tokenId !== undefined) patch.tokenId = input.tokenId;
  if (input.tokenSecret) patch.tokenSecret = input.tokenSecret;
  if (input.caCertificate !== undefined) patch.caCertificate = input.caCertificate;
  if (input.defaultNode !== undefined) patch.defaultNode = input.defaultNode;
  if (input.defaultTemplateNode !== undefined || input.defaultTemplateVmid !== undefined) {
    patch.defaultTemplate = input.defaultTemplateNode && input.defaultTemplateVmid
      ? { node: input.defaultTemplateNode, vmid: input.defaultTemplateVmid }
      : null;
  }
  if (input.defaultStorage !== undefined) patch.defaultStorage = input.defaultStorage;
  if (input.defaultPool !== undefined) patch.defaultPool = input.defaultPool;
  if (input.vmidMin !== undefined) patch.vmidMin = input.vmidMin;
  if (input.vmidMax !== undefined) patch.vmidMax = input.vmidMax;
  if (input.defaultCores !== undefined) patch.defaultCores = input.defaultCores;
  if (input.defaultMemoryMb !== undefined) patch.defaultMemoryMb = input.defaultMemoryMb;
  if (input.defaultDiskGb !== undefined) patch.defaultDiskGb = input.defaultDiskGb;
  if (input.fullClone !== undefined) patch.fullClone = input.fullClone;
  if (input.sleepRequiresTag !== undefined) patch.sleepRequiresTag = input.sleepRequiresTag;
  if (input.backupBeforeSleep !== undefined) patch.backupBeforeSleep = input.backupBeforeSleep;
  if (input.enrollUrl !== undefined) patch.enrollUrl = input.enrollUrl ? input.enrollUrl.replace(/\/+$/, "") : null;
  return patch;
}

/** Who asked, as every pane shows it while the change runs. */
function actorOf(session: Awaited<ReturnType<typeof sessionFor>>): VmActor {
  const user = session.user as { id: string; name?: unknown; email?: unknown };
  return { id: user.id, name: [user.name, user.email].find((value): value is string => typeof value === "string" && value.length > 0) ?? user.id };
}

/**
 * VM provider routes.
 *
 * Connecting a provider, reading its catalog and linking a machine are fleet changes, so they
 * take a fleet administrator. Reading the provider list does not — it carries no credential.
 */
export const vmHttpPlugin: AppPlugin = (context) => {
  const pdmux = context.services.resolve(PDMUX);
  const vm = context.services.resolve(VM);
  return new Elysia({ name: "pdmux.vm.http" })
    .onBeforeHandle(() => pdmux.database.assertReady())
    .get("/vm/providers", async ({ request }) => {
      const session = await sessionFor(pdmux, request);
      return vm.providers.list(resolveScopeId(session));
    })
    // The platforms a provider can be, and what a new one starts from — the form shows these.
    .get("/vm/provider-kinds", async ({ request }) => {
      await sessionFor(pdmux, request);
      return providerKinds();
    })
    .post("/vm/providers", async ({ request, body, set }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      const input = providerInput(dto(VmProviderDto, body));
      const created = await audit(pdmux, request, session, "vm.provider.create",
        () => vm.providers.create(resolveScopeId(session), input),
        (result) => ({ type: "vm-provider", id: result.id, label: result.name, metadata: { kind: result.kind, baseUrl: result.baseUrl } }));
      set.status = 201;
      return created;
    })
    .patch("/vm/providers/:providerId", async ({ request, params, body }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      const patch = providerPatch(dto(UpdateVmProviderDto, body));
      return audit(pdmux, request, session, "vm.provider.update",
        () => vm.providers.update(resolveScopeId(session), params.providerId, patch),
        (result) => ({ type: "vm-provider", id: result.id, label: result.name, metadata: { fields: Object.keys(patch).filter((key) => key !== "tokenSecret") } }));
    })
    .delete("/vm/providers/:providerId", async ({ request, params }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      return audit(pdmux, request, session, "vm.provider.delete",
        () => vm.providers.remove(resolveScopeId(session), params.providerId),
        (result) => ({ type: "vm-provider", id: result.id, label: result.name }));
    })
    .post("/vm/providers/:providerId/test", async ({ request, params }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      return vm.providers.test(resolveScopeId(session), params.providerId);
    })
    .get("/vm/providers/:providerId/catalog", async ({ request, params }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      return vm.providers.discover(resolveScopeId(session), params.providerId);
    })
    .put("/hosts/:hostId/vm", async ({ request, params, body }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      const input = dto(LinkHostVmDto, body);
      return audit(pdmux, request, session, "vm.link",
        () => vm.machines.link(resolveScopeId(session), params.hostId, input),
        (result) => ({ type: "host", id: params.hostId, label: result.name, metadata: { provider: result.provider.name, location: result.location, externalId: result.externalId } }));
    })
    .delete("/hosts/:hostId/vm", async ({ request, params }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      return audit(pdmux, request, session, "vm.unlink",
        () => vm.machines.unlink(resolveScopeId(session), params.hostId),
        (result) => ({ type: "host", id: params.hostId, label: result.name }));
    })
    .post("/hosts/:hostId/vm/power", async ({ request, params, body, set }) => {
      const session = await sessionFor(pdmux, request);
      const { action } = dto(PowerVmDto, body);
      if (FORCED_VM_ACTIONS.has(action)) assertCanManageFleet(session);
      else assertCanOperateHostPower(session);
      const view = await audit(pdmux, request, session, "vm.power.request",
        () => vm.operations.power(resolveScopeId(session), params.hostId, action, actorOf(session)),
        (result) => ({ type: "host", id: params.hostId, label: result.name, metadata: { action, provider: result.provider.name } }));
      // Accepted, not done: the change runs on, and every screen hears of each step.
      set.status = 202;
      return view;
    })
    .post("/vm/machines", async ({ request, body, set }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      const input = dto(CreateVmDto, body);
      const template = input.templateNode && input.templateVmid ? { node: input.templateNode, vmid: input.templateVmid } : null;
      const created = await audit(pdmux, request, session, "vm.create.request",
        () => vm.lifecycle.create(resolveScopeId(session), {
          providerId: input.providerId,
          label: input.label,
          template,
          cores: input.cores,
          memoryMb: input.memoryMb,
          diskGb: input.diskGb,
          idempotencyKey: input.idempotencyKey,
        }, actorOf(session)),
        (result) => ({ type: "host", id: result.hostId, label: result.label, metadata: { provider: result.vm.provider.name, location: result.vm.location, externalId: result.vm.externalId } }));
      set.status = 202;
      return created;
    })
    .post("/hosts/:hostId/vm/delete", async ({ request, params, body, set }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      const { confirmName } = dto(DeleteVmDto, body);
      const view = await audit(pdmux, request, session, "vm.delete.request",
        () => vm.lifecycle.remove(resolveScopeId(session), params.hostId, confirmName, actorOf(session)),
        (result) => ({ type: "host", id: params.hostId, label: result.name, metadata: { provider: result.provider.name, location: result.location, externalId: result.externalId } }));
      set.status = 202;
      return view;
    })
    .post("/hosts/:hostId/vm/enroll", async ({ request, params, set }) => {
      const session = await sessionFor(pdmux, request);
      assertCanManageFleet(session);
      const view = await audit(pdmux, request, session, "vm.enroll.request",
        () => vm.lifecycle.reenroll(resolveScopeId(session), params.hostId, actorOf(session)),
        (result) => ({ type: "host", id: params.hostId, label: result.name, metadata: { provider: result.provider.name } }));
      set.status = 202;
      return view;
    });
};

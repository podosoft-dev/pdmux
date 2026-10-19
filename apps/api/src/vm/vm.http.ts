import { Elysia } from "elysia";
import type { AppPlugin } from "../core/services";
import { assertCanManageFleet, resolveScopeId } from "../fleet/session-scope";
import { dto } from "../common/dto";
import { audit, sessionFor } from "../pdmux/pdmux.http";
import { PDMUX } from "../pdmux/pdmux.services";
import { LinkHostVmDto, UpdateVmProviderDto, VmProviderDto } from "./dto/vm.dto";
import type { VmProviderInput } from "./vm-providers.service";
import { VM } from "./vm.module-key";

function providerInput(input: VmProviderDto): VmProviderInput {
  return {
    kind: input.kind,
    name: input.name,
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
    vmidMin: input.vmidMin,
    vmidMax: input.vmidMax,
    defaultCores: input.defaultCores,
    defaultMemoryMb: input.defaultMemoryMb,
    fullClone: input.fullClone,
    sleepRequiresTag: input.sleepRequiresTag,
    backupBeforeSleep: input.backupBeforeSleep,
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
  if (input.fullClone !== undefined) patch.fullClone = input.fullClone;
  if (input.sleepRequiresTag !== undefined) patch.sleepRequiresTag = input.sleepRequiresTag;
  if (input.backupBeforeSleep !== undefined) patch.backupBeforeSleep = input.backupBeforeSleep;
  return patch;
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
    });
};

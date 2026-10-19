import { RATE_LIMIT_ROUTES } from "@podosoft/podokit-runtime";
import { Elysia } from "elysia";
import type { PodokitModule } from "../core/services";
import { isDesktopRuntime } from "../desktop/local-auth";
import { PDMUX } from "../pdmux/pdmux.services";
import { HostVm } from "./host-vm.entity";
import { HostVmsService } from "./host-vms.service";
import { VmProvider } from "./vm-provider.entity";
import { VmOperationsService } from "./vm-operations.service";
import { VmProvidersService } from "./vm-providers.service";
import { VM_POWER_BUDGET } from "./vm.contract";
import { vmHttpPlugin } from "./vm.http";
import { VM, VM_OPERATIONS } from "./vm.module-key";

/**
 * VM providers: connect a VM platform, link or create the machine behind a host, power it.
 *
 * ⚠ SERVER ONLY FOR NOW. The desktop app runs the same API on its own SQLite and would hold
 * provider credentials on a laptop; that is a decision of its own, so the module stays out of
 * a desktop runtime entirely and its screens are hidden there (`serverFeatures`).
 */
export const vmModule: PodokitModule = {
  name: "pdmux.vm",
  configure: (_env, services): void => {
    if (isDesktopRuntime()) return;
    const pdmux = services.resolve(PDMUX);
    const providers = new VmProvidersService(
      pdmux.dataSource.getRepository(VmProvider),
      pdmux.dataSource.getRepository(HostVm),
    );
    const machines = new HostVmsService(pdmux.dataSource.getRepository(HostVm), providers, pdmux.hosts, pdmux.hostEvents);
    const operations = new VmOperationsService(pdmux.dataSource.getRepository(HostVm), providers, pdmux.hostEvents);
    services.register(VM, { providers, machines, operations });
    services.register(VM_OPERATIONS, operations, () => operations.stop());
    services.onStart(() => {
      machines.connect();
      operations.start();
    });
    services.tryResolve(RATE_LIMIT_ROUTES)?.register(VM_POWER_BUDGET);
  },
  plugin: (context) => (context.services.tryResolve(VM) ? vmHttpPlugin(context) : new Elysia({ name: "pdmux.vm.http" })),
};

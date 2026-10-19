import { Elysia } from "elysia";
import type { PodokitModule } from "../core/services";
import { isDesktopRuntime } from "../desktop/local-auth";
import { PDMUX } from "../pdmux/pdmux.services";
import { HostVm } from "./host-vm.entity";
import { HostVmsService } from "./host-vms.service";
import { VmProvider } from "./vm-provider.entity";
import { VmProvidersService } from "./vm-providers.service";
import { vmHttpPlugin } from "./vm.http";
import { VM } from "./vm.module-key";

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
    services.register(VM, { providers, machines });
    services.onStart(() => machines.connect());
  },
  plugin: (context) => (context.services.tryResolve(VM) ? vmHttpPlugin(context) : new Elysia({ name: "pdmux.vm.http" })),
};

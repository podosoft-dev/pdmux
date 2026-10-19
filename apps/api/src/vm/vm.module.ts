import { RATE_LIMIT_ROUTES } from "@podosoft/podokit-runtime";
import { Elysia } from "elysia";
import type { PodokitModule } from "../core/services";
import { authBaseUrl } from "../auth/auth-environment";
import { isDesktopRuntime } from "../desktop/local-auth";
import { PDMUX } from "../pdmux/pdmux.services";
import { HostVm } from "./host-vm.entity";
import { HostVmsService } from "./host-vms.service";
import { VmProvider } from "./vm-provider.entity";
import { VmLifecycleService, type VmEnrollment } from "./vm-lifecycle.service";
import { VmFleetTools } from "./vm-mcp";
import { VmOperationsService } from "./vm-operations.service";
import { VmProvidersService } from "./vm-providers.service";
import { VM_CREATE_BUDGET, VM_POWER_BUDGET } from "./vm.contract";
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
    // A created machine enrolls like any host: with a code from the enrollments service. Its
    // current code disappears once redeemed, which is how "enrolled" is told from "waiting".
    const enrollment: VmEnrollment = {
      mint: async (organizationId, hostId, actorId) => ({ code: (await pdmux.agentEnrollments.create(organizationId, hostId, actorId)).code }),
      state: async (organizationId, hostId) => {
        const current = await pdmux.agentEnrollments.current(organizationId, hostId);
        if (!current) return "enrolled";
        if (current.status === "live") return "waiting";
        return current.status === "expired" ? "expired" : "enrolled";
      },
    };
    const lifecycle = new VmLifecycleService(
      pdmux.dataSource.getRepository(HostVm),
      providers,
      machines,
      operations,
      pdmux.hosts,
      pdmux.hostEvents,
      enrollment,
      authBaseUrl,
    );
    services.register(VM, { providers, machines, operations, lifecycle });
    pdmux.mcp.setVmTools(new VmFleetTools({ providers, machines, operations, lifecycle }, pdmux.hosts));
    services.register(VM_OPERATIONS, operations, () => operations.stop());
    services.onStart(() => {
      machines.connect();
      lifecycle.connect();
      operations.start();
    });
    const budgets = services.tryResolve(RATE_LIMIT_ROUTES);
    budgets?.register(VM_POWER_BUDGET);
    budgets?.register(VM_CREATE_BUDGET);
  },
  plugin: (context) => (context.services.tryResolve(VM) ? vmHttpPlugin(context) : new Elysia({ name: "pdmux.vm.http" })),
};

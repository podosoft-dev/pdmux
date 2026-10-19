import type { ServiceKey } from "../core/services";
import type { HostVmsService } from "./host-vms.service";
import type { VmLifecycleService } from "./vm-lifecycle.service";
import type { VmOperationsService } from "./vm-operations.service";
import type { VmProvidersService } from "./vm-providers.service";

export interface VmServices {
  providers: VmProvidersService;
  machines: HostVmsService;
  operations: VmOperationsService;
  lifecycle: VmLifecycleService;
}

export const VM = Symbol("pdmux.vm") as ServiceKey<VmServices>;

/** Registered on its own so the registry stops the reconcile loop on shutdown. */
export const VM_OPERATIONS = Symbol("pdmux.vm.operations") as ServiceKey<VmOperationsService>;

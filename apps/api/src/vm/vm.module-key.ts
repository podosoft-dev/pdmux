import type { ServiceKey } from "../core/services";
import type { HostVmsService } from "./host-vms.service";
import type { VmProvidersService } from "./vm-providers.service";

export interface VmServices {
  providers: VmProvidersService;
  machines: HostVmsService;
}

export const VM = Symbol("pdmux.vm") as ServiceKey<VmServices>;

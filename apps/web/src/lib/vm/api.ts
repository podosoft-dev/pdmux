import { api } from "#lib/api.js";
import type { CreateVmInput, CreatedVm, HostVmView, VmAction, VmCatalog, VmProviderInput, VmProviderView } from "./types";

/** The VM provider routes (`apps/api/src/vm/vm.contract.ts`). */
export const vmApi = {
  providers: (): Promise<VmProviderView[]> => api.get<VmProviderView[]>("/vm/providers"),
  createProvider: (input: VmProviderInput): Promise<VmProviderView> => api.post<VmProviderView>("/vm/providers", input),
  updateProvider: (id: string, input: Partial<VmProviderInput>): Promise<VmProviderView> =>
    api.patch<VmProviderView>(`/vm/providers/${id}`, input),
  removeProvider: (id: string): Promise<{ id: string; name: string }> => api.del<{ id: string; name: string }>(`/vm/providers/${id}`),
  testProvider: (id: string): Promise<VmProviderView> => api.post<VmProviderView>(`/vm/providers/${id}/test`, {}),
  catalog: (id: string): Promise<VmCatalog> => api.get<VmCatalog>(`/vm/providers/${id}/catalog`),
  link: (hostId: string, input: { providerId: string; node: string; vmid: number }): Promise<HostVmView> =>
    api.put<HostVmView>(`/hosts/${hostId}/vm`, input),
  unlink: (hostId: string): Promise<{ hostId: string; name: string }> => api.del<{ hostId: string; name: string }>(`/hosts/${hostId}/vm`),
  power: (hostId: string, action: VmAction): Promise<HostVmView> => api.post<HostVmView>(`/hosts/${hostId}/vm/power`, { action }),
  create: (input: CreateVmInput): Promise<CreatedVm> => api.post<CreatedVm>("/vm/machines", input),
  remove: (hostId: string, confirmName: string): Promise<HostVmView> => api.post<HostVmView>(`/hosts/${hostId}/vm/delete`, { confirmName }),
  reenroll: (hostId: string): Promise<HostVmView> => api.post<HostVmView>(`/hosts/${hostId}/vm/enroll`, {}),
};

import { describe, expect, it } from "bun:test";
import { AppException } from "../common/app-exception";
import { ORG, OTHER_ORG, addHost, providerInput, vmHarness } from "./testing/vm-harness";
import { nameFromAddress, providerKinds } from "./vm-providers.service";

async function failure(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("VmProvidersService", () => {
  it("[TC-PDVM-001] saves a provider only after its credentials reached it, and never shows the credential", async () => {
    const harness = vmHarness();
    harness.driver.failTest = new AppException("VM_PROVIDER_AUTH_FAILED", "The provider rejected the credentials", 502);
    expect((await failure(harness.providers.create(ORG, providerInput()))).code).toBe("VM_PROVIDER_AUTH_FAILED");
    expect(harness.providerRows.rows).toHaveLength(0);

    harness.driver.failTest = null;
    const view = await harness.providers.create(ORG, providerInput());
    expect(harness.factorySecrets).toEqual(["provider-secret-for-test", "provider-secret-for-test"]);
    // Stored encrypted; neither the view nor the row holds the plaintext.
    expect(JSON.stringify(view)).not.toContain("provider-secret-for-test");
    expect(String(harness.providerRows.rows[0]?.secret)).not.toContain("provider-secret-for-test");
    expect(view).toMatchObject({ name: "lab", kind: "proxmox", tokenId: "pdmux@pve!vm-provider", caFingerprint: null, machineCount: 0 });

    // A blank secret on update keeps the stored one — the screen never had it to send back.
    await harness.providers.update(ORG, view.id, { defaultCores: 4 });
    const driverFor = harness.providers.driver(await harness.providers.row(ORG, view.id));
    expect(driverFor).toBe(harness.driver);
    expect(harness.factorySecrets.at(-1)).toBe("provider-secret-for-test");
  });

  it("[TC-PDVM-007] keeps several providers of one kind per scope, named uniquely, and refuses foreign scopes", async () => {
    const harness = vmHarness();
    const cluster = await harness.providers.create(ORG, providerInput({ name: "cluster" }));
    await harness.providers.create(ORG, providerInput({ name: "standalone", baseUrl: "https://other.example.test:8006" }));
    expect((await harness.providers.list(ORG)).map((provider) => provider.name)).toEqual(["cluster", "standalone"]);
    expect((await failure(harness.providers.create(ORG, providerInput({ name: "cluster" })))).code).toBe("VM_PROVIDER_NAME_TAKEN");
    expect((await failure(harness.providers.get(OTHER_ORG, cluster.id))).code).toBe("VM_PROVIDER_NOT_FOUND");
    expect(await harness.providers.list(OTHER_ORG)).toEqual([]);
  });

  it("[TC-PDVM-007] refuses an empty id range, an unreadable CA, and removing a provider with machines", async () => {
    const harness = vmHarness();
    expect((await failure(harness.providers.create(ORG, providerInput({ vmidMin: 520, vmidMax: 519 })))).code).toBe("VM_PROVIDER_VMID_RANGE_INVALID");
    expect((await failure(harness.providers.create(ORG, providerInput({ caCertificate: "not a certificate" })))).code).toBe("VM_PROVIDER_CA_INVALID");

    const provider = await harness.providers.create(ORG, providerInput());
    const host = await addHost(harness, "box");
    harness.driver.add(500, "running");
    await harness.machines.link(ORG, host.id, { providerId: provider.id, node: "n1", vmid: 500 });
    expect((await failure(harness.providers.remove(ORG, provider.id))).code).toBe("VM_PROVIDER_IN_USE");
    expect((await harness.providers.get(ORG, provider.id)).machineCount).toBe(1);
  });

  it("[TC-PDVM-005] records a failed reachability test instead of throwing it at the settings screen", async () => {
    const harness = vmHarness();
    const provider = await harness.providers.create(ORG, providerInput());
    harness.driver.failTest = new AppException("VM_PROVIDER_TLS_FAILED", "The provider's certificate could not be verified", 502);
    expect((await harness.providers.test(ORG, provider.id)).lastErrorCode).toBe("VM_PROVIDER_TLS_FAILED");
    harness.driver.failTest = null;
    expect((await harness.providers.test(ORG, provider.id)).lastErrorCode).toBeNull();
  });

  it("[TC-PDVM-038] names a connection after its address when no name is given, without colliding", async () => {
    const harness = vmHarness();
    const first = await harness.providers.create(ORG, providerInput({ name: "" }));
    const second = await harness.providers.create(ORG, providerInput({ name: "" }));
    expect([first.name, second.name]).toEqual(["pve.example.test", "pve.example.test-2"]);
    expect(nameFromAddress("https://192.0.2.10:8006")).toBe("192.0.2.10");
    expect(nameFromAddress("not a url")).toBe("provider");
  });

  it("[TC-PDVM-038] offers each platform with what a new machine gets by default", () => {
    expect(providerKinds()).toEqual([
      { kind: "proxmox", defaults: { cores: 4, memoryMb: 16_384, diskGb: 64, vmidMin: 500, vmidMax: 599, fullClone: false } },
    ]);
  });
});

import { describe, expect, it } from "bun:test";
import type { VmProviderConfig } from "../vm-provider";
import { ProxmoxDriver, bootDisk, diskSizeGb, proxmoxState, smbiosWith, taskError } from "./proxmox.driver";

const UPID = "UPID:n1:0001A2B3:00C0FFEE:68F4A000:qmstart:500:pdmux@pve!vm-provider:";

const config: VmProviderConfig = {
  baseUrl: "https://pve.example.test:8006",
  tokenId: "pdmux@pve!vm-provider",
  caCertificate: null,
  defaults: { node: "n1", template: null, storage: null, pool: "pdmux", vmidMin: 500, vmidMax: 519, cores: 2, memoryMb: 2048, fullClone: false },
  sleepRequiresTag: null,
  backupBeforeSleep: null,
};

/** A provider that answers from a table of `METHOD path` routes and records what it was asked. */
function provider(routes: Record<string, unknown | ((body: URLSearchParams, url: URL) => unknown)>): {
  driver: ProxmoxDriver;
  calls: string[];
  bodies: URLSearchParams[];
} {
  const calls: string[] = [];
  const bodies: URLSearchParams[] = [];
  const requestFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api2/json", "");
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : url.search);
    calls.push(`${method} ${path}`);
    bodies.push(body);
    const route = routes[`${method} ${path}`];
    if (route === undefined) return Response.json({ data: null, message: `no route ${method} ${path}` }, { status: 500 });
    if (route instanceof Response) return route;
    const data = typeof route === "function" ? (route as (b: URLSearchParams, u: URL) => unknown)(body, url) : route;
    return data instanceof Response ? data : Response.json({ data });
  };
  return { driver: ProxmoxDriver.create(config, "secret", requestFetch as typeof fetch), calls, bodies };
}

describe("ProxmoxDriver", () => {
  it("[TC-PDVM-011] reads a hibernated machine from its suspend lock, whatever the status says", () => {
    expect(proxmoxState("stopped", "suspended")).toBe("hibernated");
    // Measured on 9.2.21: for a few seconds after the suspend the cluster view still says running.
    expect(proxmoxState("running", "suspended")).toBe("hibernated");
    expect(proxmoxState("running", "suspending")).toBe("running");
    expect(proxmoxState("running", "", "paused")).toBe("paused");
    expect(proxmoxState("running", "")).toBe("running");
    expect(proxmoxState("stopped", "")).toBe("stopped");
    expect(proxmoxState("", "")).toBe("unknown");
  });

  it("[TC-PDVM-003] follows a task to its end and names a failure without the provider's text", async () => {
    let polls = 0;
    const { driver } = provider({
      [`GET /nodes/n1/tasks/${encodeURIComponent(UPID)}/status`]: () =>
        ++polls === 1 ? { status: "running" } : { status: "stopped", exitstatus: "VM quit/powerdown failed - got timeout" },
    });
    const task = { id: UPID, node: "n1" };
    expect(await driver.task(task)).toEqual({ done: false });
    expect(await driver.task(task)).toEqual({ done: true, ok: false, error: "VM_TASK_TIMEOUT" });

    const ok = provider({ [`GET /nodes/n1/tasks/${encodeURIComponent(UPID)}/status`]: { status: "stopped", exitstatus: "OK" } });
    expect(await ok.driver.task(task)).toEqual({ done: true, ok: true });
    // A backup that finished with warnings exists; it is not a failure.
    const warned = provider({ [`GET /nodes/n1/tasks/${encodeURIComponent(UPID)}/status`]: { status: "stopped", exitstatus: "WARNINGS: 1" } });
    expect(await warned.driver.task(task)).toEqual({ done: true, ok: true });
    expect(taskError("can't lock file '/var/lock/qemu-server/lock-500.conf'")).toBe("VM_LOCKED");
    expect(taskError("unexpected")).toBe("VM_TASK_FAILED");
  });

  it("[TC-PDVM-009] asks for each power change the way Proxmox spells it", async () => {
    const routes: Record<string, unknown> = {};
    for (const path of ["start", "suspend", "shutdown", "stop", "reboot", "reset"]) {
      routes[`POST /nodes/n1/qemu/500/status/${path}`] = UPID;
    }
    const { driver, calls, bodies } = provider(routes);
    const ref = { node: "n1", vmid: 500 };
    for (const action of ["start", "hibernate", "shutdown", "stop", "reboot", "reset"] as const) {
      expect(await driver.power(ref, action)).toEqual({ id: UPID, node: "n1" });
    }
    expect(calls).toEqual([
      "POST /nodes/n1/qemu/500/status/start",
      "POST /nodes/n1/qemu/500/status/suspend",
      "POST /nodes/n1/qemu/500/status/shutdown",
      "POST /nodes/n1/qemu/500/status/stop",
      "POST /nodes/n1/qemu/500/status/reboot",
      "POST /nodes/n1/qemu/500/status/reset",
    ]);
    // Hibernate is a suspend TO DISK — memory saved, host memory returned.
    expect(bodies[1]?.get("todisk")).toBe("1");
    expect(bodies[2]?.get("timeout")).toBe("180");
  });

  it("[TC-PDVM-005] discovers nodes, templates, storage, bridges and pools", async () => {
    const { driver } = provider({
      "GET /nodes": [{ node: "n1", status: "online" }, { node: "n2", status: "offline" }],
      "GET /cluster/resources": [
        { type: "qemu", vmid: 9001, node: "n1", name: "ubuntu-template", template: 1, status: "stopped", tags: "pdmux-template" },
        { type: "qemu", vmid: 500, node: "n1", name: "vm-500", template: 0, status: "running" },
      ],
      "GET /nodes/n1/storage": [{ storage: "local-lvm", type: "lvmthin", content: "images,rootdir" }],
      "GET /nodes/n1/network": [{ iface: "vmbr0", type: "bridge" }],
      "GET /pools": [{ poolid: "pdmux" }, { poolid: "pdmux-linked" }],
    });
    expect(await driver.discover()).toEqual({
      nodes: [{ name: "n1", online: true }, { name: "n2", online: false }],
      templates: [{ ref: { node: "n1", vmid: 9001 }, name: "ubuntu-template", tags: ["pdmux-template"] }],
      // An offline node is not asked about its storage — it would only time out.
      storages: [{ node: "n1", id: "local-lvm", type: "lvmthin", content: ["images", "rootdir"] }],
      bridges: [{ node: "n1", name: "vmbr0" }],
      pools: ["pdmux", "pdmux-linked"],
    });
  });

  it("[TC-PDVM-012] lists every visible machine in one call with its state", async () => {
    const { driver, calls } = provider({
      "GET /cluster/resources": [
        { type: "qemu", vmid: 500, node: "n1", name: "a", status: "running", maxmem: 2147483648, maxcpu: 2, tags: "pdmux;on-demand" },
        { type: "qemu", vmid: 501, node: "n1", name: "b", status: "stopped", lock: "suspended" },
        { type: "lxc", vmid: 600, node: "n1", name: "container", status: "running" },
      ],
    });
    expect(await driver.list()).toEqual([
      { ref: { node: "n1", vmid: 500 }, name: "a", state: "running", tags: ["pdmux", "on-demand"], template: false, memoryMb: 2048, cores: 2 },
      { ref: { node: "n1", vmid: 501 }, name: "b", state: "hibernated", tags: [], template: false, memoryMb: null, cores: null },
    ]);
    expect(calls).toEqual(["GET /cluster/resources"]);
  });

  it("[TC-PDVM-037] rewrites the firmware fields without losing the machine's identity", async () => {
    expect(smbiosWith("uuid=587b6e87-bde6-4be0-a74c-200d07c48043", { serial: "pdmxe_ABCDE", sku: "https://pdmux.example.com" }))
      .toBe(`uuid=587b6e87-bde6-4be0-a74c-200d07c48043,base64=1,serial=${btoa("pdmxe_ABCDE")},sku=${btoa("https://pdmux.example.com")}`);
    // Clearing keeps the uuid and any field somebody else set, re-encoded once.
    expect(smbiosWith(`uuid=u1,base64=1,serial=${btoa("old")},sku=${btoa("x")},family=${btoa("lab")}`, null))
      .toBe(`uuid=u1,base64=1,family=${btoa("lab")}`);
    expect(smbiosWith("uuid=u1,manufacturer=Acme", null)).toBe(`uuid=u1,base64=1,manufacturer=${btoa("Acme")}`);
    expect(smbiosWith("", null)).toBe("");

    const { driver, calls, bodies } = provider({
      "GET /nodes/n1/qemu/500/config": { smbios1: "uuid=u1" },
      "PUT /nodes/n1/qemu/500/config": null,
    });
    await driver.configure({ node: "n1", vmid: 500 }, { memoryMb: 2048, balloonMb: 2048, tags: ["pdmux", "on-demand"], firmware: { serial: "c", sku: "s" } });
    expect(calls).toEqual(["GET /nodes/n1/qemu/500/config", "PUT /nodes/n1/qemu/500/config"]);
    expect(Object.fromEntries(bodies[1] ?? [])).toEqual({
      memory: "2048",
      balloon: "2048",
      tags: "pdmux;on-demand",
      smbios1: `uuid=u1,base64=1,serial=${btoa("c")},sku=${btoa("s")}`,
    });
  });

  it("[TC-PDVM-028] tells a free id from one taken by a machine these credentials cannot see", async () => {
    const { driver } = provider({
      "GET /cluster/nextid": (_body: URLSearchParams, url: URL) =>
        url.searchParams.get("vmid") === "161"
          ? Response.json({ data: null, message: "Parameter verification failed.", errors: { vmid: "VM 161 already exists" } }, { status: 400 })
          : url.searchParams.get("vmid"),
      "GET /nodes/n1/storage/backups/content": [{ ctime: 1792396511 }, { ctime: 1792300000 }],
    });
    expect(await driver.vmidFree(501)).toBe(true);
    expect(await driver.vmidFree(161)).toBe(false);
    expect(await driver.lastBackupAt(500, "n1", "backups")).toBe(1792396511000);
  });

  it("[TC-PDVM-039] grows the boot disk only when it is smaller, and finds which disk boots", async () => {
    expect(bootDisk({ boot: "order=ide2;scsi0;net0", ide2: "local-lvm:vm-501-cloudinit,media=cdrom", scsi0: "local-lvm:vm-501-disk-0,size=24064M" })).toBe("scsi0");
    expect(bootDisk({ bootdisk: "virtio0", virtio0: "local:501/vm-501-disk-0.qcow2,size=32G" })).toBe("virtio0");
    expect(bootDisk({ ide2: "none,media=cdrom" })).toBeNull();
    expect(diskSizeGb("local-lvm:vm-501-disk-0,discard=on,size=24064M")).toBe(23.5);
    expect(diskSizeGb("x,size=1T")).toBe(1024);

    const small = provider({
      "GET /nodes/n1/qemu/501/config": { boot: "order=scsi0;net0", scsi0: "local-lvm:vm-501-disk-0,discard=on,size=24064M" },
      "PUT /nodes/n1/qemu/501/resize": UPID,
    });
    expect(await small.driver.resizeDisk({ node: "n1", vmid: 501 }, 64)).toEqual({ id: UPID, node: "n1" });
    expect(Object.fromEntries(small.bodies.at(-1) ?? [])).toEqual({ disk: "scsi0", size: "64G" });

    // Disks only grow: a template already this large is left alone, with no request.
    const large = provider({ "GET /nodes/n1/qemu/501/config": { scsi0: "local-lvm:vm-501-disk-0,size=128G" } });
    expect(await large.driver.resizeDisk({ node: "n1", vmid: 501 }, 64)).toBeNull();
    expect(large.calls).toEqual(["GET /nodes/n1/qemu/501/config"]);
  });
});

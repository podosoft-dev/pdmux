import { describe, expect, it, mock } from "bun:test";
import { UpdateCoordinator } from "./updater.js";

describe("[TC-PDDESKTOP-008] desktop updater", () => {
  it("does nothing in an unpackaged development run", async () => {
    const checkForUpdates = mock(async () => undefined);
    const coordinator = new UpdateCoordinator(false, {
      checkForUpdates,
      quitAndInstall: mock(() => undefined),
    }, { create: mock(async () => "/backup") }, async () => true, async () => undefined);
    expect(await coordinator.check()).toBe(false);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("backs up before installing a downloaded update", async () => {
    const order: string[] = [];
    const coordinator = new UpdateCoordinator(true, {
      checkForUpdates: async () => undefined,
      quitAndInstall: () => { order.push("install"); },
    }, {
      create: async () => { order.push("backup"); return "/backup"; },
    }, async () => true, async () => { order.push("stop-runtime"); });
    expect(await coordinator.installDownloadedUpdate()).toBe(true);
    expect(order).toEqual(["backup", "stop-runtime", "install"]);
  });

  it("allows the window to close before the updater closes it", async () => {
    let quitting = false;
    let prevented = false;
    const coordinator = new UpdateCoordinator(true, {
      checkForUpdates: async () => undefined,
      quitAndInstall: () => { prevented = !quitting; },
    }, { create: async () => "/backup" }, async () => true, async () => {
      quitting = true;
    });
    await coordinator.installDownloadedUpdate();
    expect(prevented).toBe(false);
  });

  it("does not stop the runtime or install when cancelled", async () => {
    const create = mock(async () => "/backup");
    const prepare = mock(async () => undefined);
    const install = mock(() => undefined);
    const coordinator = new UpdateCoordinator(true, {
      checkForUpdates: async () => undefined, quitAndInstall: install,
    }, { create }, async () => false, prepare);
    expect(await coordinator.installDownloadedUpdate()).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("keeps the runtime running if backup fails", async () => {
    const prepare = mock(async () => undefined);
    const install = mock(() => undefined);
    const coordinator = new UpdateCoordinator(true, {
      checkForUpdates: async () => undefined, quitAndInstall: install,
    }, { create: async () => { throw new Error("Backup failed"); } }, async () => true, prepare);
    await expect(coordinator.installDownloadedUpdate()).rejects.toThrow("Backup failed");
    expect(prepare).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("awaits runtime cleanup before installing", async () => {
    let finish: (() => void) | undefined;
    const cleanup = new Promise<void>(resolve => { finish = resolve; });
    const install = mock(() => undefined);
    const prepare = mock(() => cleanup);
    const coordinator = new UpdateCoordinator(true, {
      checkForUpdates: async () => undefined, quitAndInstall: install,
    }, { create: async () => "/backup" }, async () => true, prepare);
    const result = coordinator.installDownloadedUpdate();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    finish?.();
    expect(await result).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("does not install if runtime cleanup fails", async () => {
    const install = mock(() => undefined);
    const coordinator = new UpdateCoordinator(true, {
      checkForUpdates: async () => undefined, quitAndInstall: install,
    }, { create: async () => "/backup" }, async () => true, async () => {
      throw new Error("Cleanup failed");
    });
    await expect(coordinator.installDownloadedUpdate()).rejects.toThrow("Cleanup failed");
    expect(install).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, mock } from "bun:test";
import { UpdateCoordinator, type UpdateView } from "./updater.js";

function fixture(available = true): { coordinator: UpdateCoordinator; view: UpdateView; calls: string[]; client: { checkForUpdates: ReturnType<typeof mock>; downloadUpdate: ReturnType<typeof mock>; quitAndInstall: ReturnType<typeof mock> } } {
  const calls: string[] = [];
  const client = {
    checkForUpdates: mock(async () => { calls.push("check"); return { isUpdateAvailable: available, updateInfo: { version: "1.2.3" } }; }),
    downloadUpdate: mock(async () => { calls.push("download"); }),
    quitAndInstall: mock(() => { calls.push("install"); }),
  };
  const view: UpdateView = {
    show: (stage, progress) => { calls.push(`${stage}${progress ? `:${progress.percent}` : ""}`); },
    close: () => { calls.push("close"); },
    confirmDownload: mock(async version => { calls.push(`available:${version}`); return true; }),
    current: mock(async () => { calls.push("current"); }),
    disabled: mock(async () => { calls.push("disabled"); }),
    failed: mock(async () => { calls.push("failed"); }),
  };
  const coordinator = new UpdateCoordinator(true, client, { create: async () => { calls.push("backup"); return "/backup"; } }, async () => { calls.push("restart"); return false; }, async () => { calls.push("stop"); }, view);
  return { coordinator, client, view, calls };
}

describe("[TC-PDDESKTOP-008] desktop updater", () => {
  it("shows checking and an explicit no-update result for a manual check", async () => {
    const state = fixture(false); await state.coordinator.check(true);
    expect(state.calls).toEqual(["checking", "check", "close", "current"]);
    expect(state.client.downloadUpdate).not.toHaveBeenCalled();
  });
  it("keeps a background no-update result silent", async () => {
    const state = fixture(false); await state.coordinator.check();
    expect(state.calls).not.toContain("checking"); expect(state.calls).not.toContain("current");
  });
  it("shows the result when a manual click joins a background check", async () => {
    const state = fixture(false); let finish: (() => void) | undefined;
    state.client.checkForUpdates = mock(() => new Promise(resolve => { finish = () => resolve({ isUpdateAvailable: false }); }));
    const background = state.coordinator.check(); const manual = state.coordinator.check(true);
    finish?.(); await Promise.all([background,manual]);
    expect(state.client.checkForUpdates).toHaveBeenCalledTimes(1); expect(state.calls).toContain("checking"); expect(state.calls).toContain("current");
  });
  it("requires download consent and then offers restart only after the download completes", async () => {
    const state = fixture(); await state.coordinator.check(true);
    expect(state.calls).toEqual(["checking", "check", "close", "available:1.2.3", "downloading:0", "download", "close", "restart"]);
    expect(state.client.quitAndInstall).not.toHaveBeenCalled();
  });
  it("does not download when the available update is declined", async () => {
    const state = fixture(); state.view.confirmDownload = async () => false;
    await state.coordinator.check(true);
    expect(state.client.downloadUpdate).not.toHaveBeenCalled(); expect(state.calls).not.toContain("restart");
  });
  it("shares concurrent checks and reports bounded download progress", async () => {
    const state = fixture(); let finish: (() => void) | undefined;
    state.client.downloadUpdate = mock(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = state.coordinator.check(true);
    for (let attempt = 0; !finish && attempt < 20; attempt += 1) await new Promise(resolve => setTimeout(resolve,0));
    const second = state.coordinator.check(true);
    state.coordinator.progress({ percent: 42, transferred: 42, total: 100 });
    state.coordinator.progress({ percent: 140, transferred: 100, total: 100 });
    expect(state.calls).toContain("downloading:42"); expect(state.calls).toContain("downloading:100");
    finish?.(); await Promise.all([first,second]);
    expect(state.client.checkForUpdates).toHaveBeenCalledTimes(1); expect(state.client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(state.calls.filter(call => call === "restart")).toHaveLength(1);
  });
  it("reuses a completed download when restart was postponed", async () => {
    const state = fixture(); await state.coordinator.check(true); await state.coordinator.check(true);
    expect(state.client.checkForUpdates).toHaveBeenCalledTimes(1); expect(state.client.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(state.calls.filter(call => call === "restart")).toHaveLength(2);
  });
  it("closes progress and reports a failed manual check", async () => {
    const state = fixture(); state.client.checkForUpdates = mock(async () => { throw new Error("offline"); });
    await expect(state.coordinator.check(true)).rejects.toThrow("offline");
    expect(state.calls).toEqual(["checking", "close", "failed"]); expect(state.calls).not.toContain("restart");
  });
  it("reports a failed download without offering restart or stopping the workspace", async () => {
    const state = fixture(); state.client.downloadUpdate = mock(async () => { throw new Error("download failed"); });
    await expect(state.coordinator.check(true)).rejects.toThrow("download failed");
    expect(state.calls).toContain("failed"); expect(state.calls).not.toContain("restart"); expect(state.calls).not.toContain("stop");
  });
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

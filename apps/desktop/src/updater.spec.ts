import { describe, expect, it, mock } from "bun:test";
import { UpdateCoordinator } from "./updater.js";

describe("[TC-PDDESKTOP-008] desktop updater", () => {
  it("does nothing in an unpackaged development run", async () => {
    const checkForUpdates = mock(async () => undefined);
    const coordinator = new UpdateCoordinator(false, {
      checkForUpdates,
      quitAndInstall: mock(() => undefined),
    }, { create: mock(async () => "/backup") }, async () => true);
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
    }, async () => true);
    expect(await coordinator.installDownloadedUpdate()).toBe(true);
    expect(order).toEqual(["backup", "install"]);
  });
});

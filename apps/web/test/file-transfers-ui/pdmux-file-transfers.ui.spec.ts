import { expect, test, type Page } from "@playwright/test";
import type { FileTransferEntryView, FileTransferView } from "@pdmux/protocol";

interface Fixture {
  jobs: FileTransferView[];
  entries: FileTransferEntryView[];
  chunks: number[];
  release: () => void;
}
async function fixture(page: Page): Promise<Fixture> {
  const jobs: FileTransferView[] = [];
  const entries: FileTransferEntryView[] = [];
  const chunks: number[] = [];
  let release: () => void = (): void => {};
  const delay = new Promise<void>((resolve): void => { release = resolve; });
  await page.addInitScript((): void => {
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => ({
      kind: "directory", name: "folder",
      async *values() {
        yield { kind: "directory", name: "empty", async *values() {} };
        yield { kind: "file", name: "file.txt", getFile: async () => new File([new Uint8Array(2 * 1_048_576 + 7)], "file.txt", { lastModified: 1 }) };
      },
    }) });
  });
  await page.route("**/api/hosts/**", async (route): Promise<void> => {
    const request = route.request();
    const url = new URL(request.url());
    const suffix = url.pathname.split("/file-transfers")[1];
    if (suffix === undefined) {
      await route.fulfill({ json: { path: url.searchParams.get("path") ?? "", home: "/home/example", entries: [], dropped: 0, truncated: false, error: null } });
      return;
    }
    const body = request.method() === "PUT" ? null : request.postDataJSON() as Record<string, unknown> | null;
    let answer: unknown = jobs;
    if (!suffix && request.method() === "POST") {
      const input = body as { id: string; basePath: string; direction: "upload" | "download" };
      const job: FileTransferView = { ...input, hostId: "11111111-1111-4111-8111-111111111111", state: "draft",
        bytes: 0, totalBytes: 0, completedEntries: 0, totalEntries: 0, currentPath: "", errorCode: "",
        exclusions: [], archiveBytes: 0, updated: 0, created: 0 };
      jobs.push(job);
      answer = job;
    } else if (suffix) {
      const parts = suffix.split("/");
      const job = jobs.find((job) => job.id === parts[1]);
      if (!job) { await route.fulfill({ status: 404, json: { error: { code: "FILES_TRANSFER_NOT_FOUND" } } }); return; }
      answer = job;
      if (parts[2] === "download") {
        await route.fulfill({ contentType: "application/zip", headers: { "content-disposition": 'attachment; filename="files.zip"' }, body: Buffer.from("fixture ZIP") });
        return;
      } else if (parts[2] === "manifest") {
        entries.push(...(body?.entries as FileTransferEntryView[]).map((entry) => ({ ...entry, offset: 0, replace: false, state: "pending" as const })));
        job.totalEntries = entries.length;
        job.totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      } else if (parts[2] === "control") {
        job.state = body?.action === "start" ? "running" : "paused";
      } else if (parts[2] === "entries" && !parts[3]) {
        answer = entries;
      } else if (parts[2] === "entries") {
        const entry = entries.find((entry) => entry.id === parts[3]);
        if (!entry) throw new Error("Unknown fixture entry");
        answer = entry;
        if (parts[4] === "chunk") {
          if (!entry.replace) {
            await route.fulfill({ status: 409, json: { success: false, error: { code: "FILES_TRANSFER_CONFLICT", message: "Conflict" } } });
            return;
          }
          const bytes = request.postDataBuffer()?.length ?? 0;
          expect(bytes).toBeLessThanOrEqual(1_048_576);
          chunks.push(bytes);
          if (chunks.length === 2) await delay;
          entry.offset = Number(request.headers()["x-transfer-offset"]) + bytes;
          job.bytes = entry.offset;
          job.currentPath = entry.path;
        } else if (parts[4] === "decision") {
          entry.replace = body?.action === "replace";
          if (body?.action === "skip") entry.state = "skipped";
        } else if (parts[4] === "commit") {
          entry.state = "committed";
          job.completedEntries++;
          if (job.completedEntries === job.totalEntries) job.state = "completed";
        }
      }
    }
    await route.fulfill({ json: answer });
  });
  return { jobs, entries, chunks, release };
}

test("[TC-PDFILE-008] reviews native source exclusions before uploading an empty tree", async ({ page }, testInfo): Promise<void> => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.addInitScript((): void => {
    Object.defineProperty(window, "pdmuxDesktop", { value: { isDesktop: true, transfers: {
      pickFolder: async () => ({ token: "selection", entries: [
        { path: "folder", kind: "directory", size: 0, modified: "" },
        { path: "folder/empty", kind: "directory", size: 0, modified: "" },
      ], exclusions: ["folder/link"] }),
      release: async (): Promise<void> => {},
      read: async (): Promise<never> => { throw new Error("Excluded source was read"); },
    } } });
  });
  await page.goto("/");
  await page.getByTestId("files-upload-folder").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("folder/link");
  expect(state.jobs).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("source-exclusion-review.png"), fullPage: true });
  const box = await dialog.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
  await dialog.getByRole("button", { name: "Cancel transfer", exact: true }).click();
  expect(state.jobs).toHaveLength(0);
  await page.getByTestId("files-upload-folder").click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "completed");
  expect(state.entries.map((entry) => entry.path)).toEqual(["folder", "folder/empty"]);
  expect(state.chunks).toEqual([]);
});

for (const width of [1280, 390]) {
  test(`[TC-PDFILE-008] select folders and download mixed entries at ${width}px`, async ({ page }, testInfo): Promise<void> => {
    await page.setViewportSize({ width, height: 844 });
    const state = await fixture(page);
    await page.goto("/");
    await page.getByTestId("files-select-mode").click();
    await page.locator('[data-pdmux-entry="folder"]').click();
    await page.locator('[data-pdmux-entry="file.txt"]').click();
    await expect(page.locator('[data-pdmux-entry="folder"]')).toHaveAttribute("data-pdmux-selected", "true");
    const created = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/file-transfers"));
    await page.getByTestId("files-download").click();
    expect((await created).postDataJSON()).toMatchObject({ direction: "download", basePath: "destination", selection: ["folder", "file.txt"] });
    await expect.poll(() => state.jobs[0]?.state).toBe("running");
    const job = state.jobs[0]!;
    Object.assign(job, { state: "ready", totalBytes: 7, bytes: 7, completedEntries: 3, totalEntries: 3 });
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "ready");
    await page.screenshot({ path: testInfo.outputPath("folder-download-ready.png"), fullPage: true });
    const panel = await page.getByTestId("file-transfer-panel").boundingBox();
    const count = await page.getByText("3 / 3 items", { exact: true }).boundingBox();
    expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    expect((count?.x ?? 0) + (count?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save ZIP", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("files.zip");
  });
  test(`[TC-PDFILE-008] folder conflict, bounded progress and geometry at ${width}px`, async ({ page }, testInfo): Promise<void> => {
    await page.setViewportSize({ width, height: 844 });
    const state = await fixture(page);
    await page.goto("/");
    const explorer = page.getByTestId("file-explorer");
    await expect(explorer).toBeVisible();
    const before = await explorer.boundingBox();
    expect(before?.height).toBeGreaterThan(200);
    await page.getByTestId("files-upload-folder").click();
    const conflict = page.getByTestId("transfer-conflict");
    await expect(conflict).toBeVisible();
    const box = await conflict.boundingBox();
    await page.screenshot({ path: testInfo.outputPath("folder-transfer-conflict.png"), fullPage: true });
    await testInfo.attach("conflict-geometry", { body: JSON.stringify({
      box,
      button: await conflict.getByRole("button", { name: "Overwrite", exact: true }).boundingBox(),
    }), contentType: "application/json" });
    expect(box?.y).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844);
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    await conflict.getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect.poll(() => state.chunks.length).toBe(2);
    expect(state.entries.some((entry) => entry.path === "folder/empty" && entry.kind === "directory")).toBe(true);
    const progress = page.getByTestId("transfer-job").getByRole("progressbar");
    await expect(progress).toHaveAttribute("aria-valuenow", /49\./);
    await page.getByTestId("files-path-edit").click();
    await page.getByTestId("files-path-input").fill("another-directory");
    await page.getByTestId("files-path-input").press("Enter");
    expect(state.jobs[0]?.basePath).toBe("destination");
    const after = await explorer.boundingBox();
    expect(after?.height).toBeGreaterThan(150);
    const panel = await page.getByTestId("file-transfer-panel").boundingBox();
    expect((panel?.x ?? 0) + (panel?.width ?? 0)).toBeLessThanOrEqual(width + 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await testInfo.attach("geometry", { body: JSON.stringify({ before, after, panel }), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("folder-transfer-progress.png"), fullPage: true });
    await page.getByTestId("transfer-job").getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "paused");
    state.release();
    await expect.poll(() => state.entries.find((entry) => entry.kind === "file")?.offset).toBe(2 * 1_048_576);
    await page.reload();
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "paused");
    await page.getByTestId("transfer-job").getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Upload folder", exact: true }).click();
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "completed");
    expect(state.chunks).toEqual([1_048_576, 1_048_576, 7]);
    await page.reload();
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "completed");
  });
}

import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import type { FileTransferEntryView, FileTransferView } from "@pdmux/protocol";
import { MARKDOWN_SAMPLE } from "./preview-assets";

/** A refused chunk. 429 and 503 are waited out; any other status pauses the upload. */
interface Refusal { status: 400 | 429 | 503; retryAfter?: string; code?: string }
interface Fixture {
  jobs: FileTransferView[];
  entries: FileTransferEntryView[];
  chunks: number[];
  /** Every chunk request, refused or not, with the time it arrived. */
  chunkRequests: Array<{ at: number; status: number }>;
  controls: string[];
  release: () => void;
}
async function fixture(page: Page, refusals: Refusal[] = []): Promise<Fixture> {
  const jobs: FileTransferView[] = [];
  const entries: FileTransferEntryView[] = [];
  const chunks: number[] = [];
  const chunkRequests: Fixture["chunkRequests"] = [];
  const controls: string[] = [];
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
      if (url.pathname.endsWith("/files/content")) {
        const path = url.searchParams.get("path") ?? "";
        const content = path.endsWith(".md") ? MARKDOWN_SAMPLE : "INFO ready\n<literal>";
        await route.fulfill({ json: { path, lines: content.split("\n"), bytes: content.length, binary: false, truncated: false, error: null } }); return;
      }
      if (url.pathname.endsWith("/files/download")) { await route.fallback(); return; }
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
      if (request.method() === "DELETE") {
        jobs.splice(jobs.indexOf(job), 1);
        await route.fulfill({ json: { id: job.id } });
        return;
      }
      answer = job;
      if (parts[2] === "download") {
        await route.fulfill({ contentType: "application/zip", headers: { "content-disposition": 'attachment; filename="files.zip"' }, body: Buffer.from("fixture ZIP") });
        return;
      } else if (parts[2] === "manifest") {
        entries.push(...(body?.entries as FileTransferEntryView[]).map((entry) => ({ ...entry, offset: 0, replace: false, state: "pending" as const })));
        job.totalEntries = entries.length;
        job.totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
      } else if (parts[2] === "control") {
        controls.push(String(body?.action));
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
          const refusal = refusals.shift();
          chunkRequests.push({ at: Date.now(), status: refusal?.status ?? 200 });
          if (refusal) {
            const code = refusal.code ?? (refusal.status === 429 ? "RATE_LIMIT_EXCEEDED" : "BACKEND_UNAVAILABLE");
            await route.fulfill({ status: refusal.status, headers: refusal.retryAfter ? { "retry-after": refusal.retryAfter } : {},
              json: { success: false, error: { code, message: code, statusCode: refusal.status } } });
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
  return { jobs, entries, chunks, chunkRequests, controls, release };
}

async function details(page: Page, group: "current" | "history" = "current"): Promise<void> {
  if (!await page.getByTestId("transfers-dialog").isVisible()) await page.getByTestId("transfers-summary").click();
  await page.getByRole("tab", { name: group === "history" ? /^History/ : /^In progress/ }).click();
}

async function closeDetails(page: Page): Promise<void> {
  await page.getByTestId("transfers-dialog").getByRole("button", { name: "Close", exact: true }).first().click();
}

test("[TC-PDFILE-008][TC-PDFILE-020] keeps history in one dialog without shrinking the explorer", async ({ page }, testInfo): Promise<void> => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  for (let index = 0; index < 8; index++) state.jobs.push({
    id: crypto.randomUUID(), hostId: "11111111-1111-4111-8111-111111111111", direction: "upload",
    basePath: `destination/file-${index}.txt`, state: index === 7 ? "paused" : "completed",
    bytes: 7, totalBytes: 7, completedEntries: 1, totalEntries: 1, currentPath: `file-${index}.txt`,
    errorCode: "", exclusions: [], archiveBytes: 0, updated: index, created: index,
  });
  await page.goto("/");
  const panel = page.getByTestId("file-transfer-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("transfers-dialog")).toHaveCount(0);
  const explorerBefore = await page.getByTestId("file-explorer").boundingBox();
  expect((await panel.boundingBox())?.height).toBeLessThanOrEqual(40);
  await details(page, "history");
  const list = page.getByTestId("transfer-list");
  await expect(page.getByTestId("transfer-job")).toHaveCount(7);
  const before = await list.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(before.scrollHeight).toBeGreaterThan(before.height);
  await page.getByTestId("transfer-job").last().scrollIntoViewIfNeeded();
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("transfer-history-scroll.png"), fullPage: true });
  const one = state.jobs[0]!;
  await page.locator(`[data-transfer-id="${one.id}"]`).getByRole("button", { name: `Clear transfer ${one.basePath}` }).click();
  await expect(page.getByTestId("transfer-job")).toHaveCount(6);
  await closeDetails(page); await page.reload();
  await expect(page.getByTestId("transfers-dialog")).toHaveCount(0);
  await details(page, "history");
  await page.getByRole("button", { name: "Clear finished" }).click();
  await expect(page.getByTestId("transfer-job")).toHaveCount(0);
  await details(page);
  await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "paused");
  await closeDetails(page);
  const explorerAfter = await page.getByTestId("file-explorer").boundingBox();
  expect(explorerAfter?.height).toBe(explorerBefore?.height);
  await testInfo.attach("transfer-history-geometry", { body: JSON.stringify({ list: before, explorerBefore, explorerAfter }), contentType: "application/json" });
  expect(state.jobs).toHaveLength(1);
});

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
  await expect.poll(() => state.jobs[0]?.state).toBe("completed");
  await details(page, "history");
  await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "completed");
  expect(state.entries.map((entry) => entry.path)).toEqual(["folder", "folder/empty"]);
  expect(state.chunks).toEqual([]);
});

const box = (page: Page, name: string): Locator => page.getByRole("checkbox", { name: `Select ${name}`, exact: true });
const row = (page: Page, name: string): Locator => page.locator(`[data-pdmux-entry="${name}"]`);
const selectAll = (page: Page): Locator => page.getByRole("checkbox", { name: "Select all", exact: true });
const UPGRADE = "Update the host agent to transfer folders.";
/**
 * The count's words live in its title (and a screen-reader copy): a narrow toolbar shows only
 * the number, so the visible text is not the thing to assert.
 */
async function expectSelected(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId("files-selection-count")).toHaveAttribute("title", `${count} selected`);
}

interface BoxContrast {
  border: string;
  ratio: number;
  hoverRatio: number;
  borderStyle: string;
  opacity: number;
  cursor: string;
  labelCursor: string;
  fill: string;
  title: string;
}

/**
 * The contrast of a checkbox's border against the row it sits on, as WCAG computes it.
 *
 * ⚠ THE COLOURS ARE READ THROUGH A CANVAS, NOT PARSED. The app's tokens are `oklch()` and
 * one of them is translucent (`--input` is 15% white in dark mode), so the only honest way
 * to get the sRGB a person sees is to let the engine paint it and read the pixel back,
 * then composite translucent layers over what is under them.
 */
async function boxContrast(page: Page, name: string): Promise<BoxContrast> {
  return page.evaluate(async (entry): Promise<BoxContrast> => {
    // A colour read mid-transition is neither the old colour nor the new one.
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: [number, number, number, number], base: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => top[i]! * top[3] + base[i]! * (1 - top[3])) as [number, number, number];
    const backdrop = (node: Element | null): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let element = node; element; element = element.parentElement) {
        const colour = rgba(getComputedStyle(element).backgroundColor);
        if (colour[3] > 0) layers.push(colour);
        if (colour[3] >= 1) break;
      }
      return layers.reverse().reduce<[number, number, number]>((base, layer) => over(layer, base), [255, 255, 255]);
    };
    const luminance = ([r, g, b]: [number, number, number]): number => {
      const channel = (value: number): number => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a: [number, number, number], b: [number, number, number]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };
    const item = document.querySelector(`[data-pdmux-entry="${entry}"]`) as HTMLElement;
    const box = item.querySelector(".pdmux-files-checkbox") as HTMLInputElement;
    const style = getComputedStyle(box);
    const row = backdrop(item);
    const hover = over(rgba(getComputedStyle(item).getPropertyValue("--pdmux-hover")), backdrop(item.parentElement));
    return {
      border: style.borderTopColor,
      ratio: ratio(over(rgba(style.borderTopColor), row), row),
      hoverRatio: ratio(over(rgba(style.borderTopColor), hover), hover),
      borderStyle: style.borderTopStyle,
      opacity: Number(style.opacity),
      cursor: style.cursor,
      labelCursor: getComputedStyle(box.parentElement as HTMLElement).cursor,
      fill: style.backgroundColor,
      title: box.title,
    };
  }, name);
}

for (const width of [1280, 390]) {
  // ⚠ THE PHONE WIDTH IS ALSO A TOUCH SCREEN HERE. A 390px desktop window would prove the
  // layout and nothing about fingers: `hasTouch` + `isMobile` switch Chromium to a coarse
  // pointer, which is what gives the rows their 32px, and every action below is a tap.
  test.describe(`checkbox selection at ${width}px`, (): void => {
    const touch = width === 390;
    test.use({ viewport: { width, height: 844 }, ...(touch ? { hasTouch: true, isMobile: true, userAgent: devices["Pixel 7"].userAgent } : {}) });
    const press = (target: Locator): Promise<void> => (touch ? target.tap() : target.click());

    test(`[TC-PDFILE-008] select folders and download mixed entries at ${width}px`, async ({ page }, testInfo): Promise<void> => {
      const state = await fixture(page);
      await page.goto("/");
      await press(box(page, "folder"));
      await press(box(page, "file.txt"));
      await expect(row(page, "folder")).toHaveAttribute("data-pdmux-selected", "true");
      await expect(box(page, "folder")).toBeChecked();
      // Checking a folder is not opening it.
      await expect(page.locator('[data-pdmux-crumb="destination"]')).toHaveAttribute("aria-current", "location");
      await expect(page.getByTestId("files-download")).toHaveAttribute("title", "Download 2 item(s)");
      const created = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/file-transfers"));
      await press(page.getByTestId("files-download"));
      expect((await created).postDataJSON()).toMatchObject({ direction: "download", basePath: "destination", selection: ["folder", "file.txt"] });
      await expect.poll(() => state.jobs[0]?.state).toBe("running");
      const job = state.jobs[0]!;
      Object.assign(job, { state: "ready", totalBytes: 7, bytes: 7, completedEntries: 3, totalEntries: 3 });
      await details(page);
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

    test(`[TC-PDFILE-011] a box selects, a name navigates, and the count belongs to the directory at ${width}px`, async ({ page }, testInfo): Promise<void> => {
      await fixture(page);
      await page.goto("/");
      const download = page.getByTestId("files-download");
      const actionsBefore = await download.boundingBox();

      await press(box(page, "folder"));
      await expectSelected(page, 1);
      if (touch) {
        await press(box(page, "notes.md"));
        await expectSelected(page, 2);
      } else {
        // Shift on a box draws the range from the last box clicked, in the order on screen.
        await box(page, "notes.md").click({ modifiers: ["Shift"] });
        await expectSelected(page, 3);
        await expect(box(page, "file.txt")).toBeChecked();
      }
      // A box never asks the host for a preview.
      await expect(page.locator("[data-pdmux-files-preview]")).toHaveCount(0);

      // ⚠ THE COUNT SITS LEFT OF THE ACTIONS SO IT CANNOT MOVE THEM — the host picker gives
      // up the room. A Download button that jumped as boxes were ticked would be missed.
      const actionsAfter = await download.boundingBox();
      expect(Math.abs((actionsAfter?.x ?? 0) - (actionsBefore?.x ?? 0))).toBeLessThanOrEqual(1);
      const geometry = await page.evaluate(() => {
        const rect = (node: Element | null): { x: number; width: number; height: number } | null => {
          if (!node) return null;
          const box = node.getBoundingClientRect();
          return { x: Math.round(box.x * 10) / 10, width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
        };
        const item = document.querySelector('[data-pdmux-entry="file.txt"]');
        const header = document.querySelector('[data-testid="files-dock"] > header') as HTMLElement;
        return {
          coarse: matchMedia("(pointer: coarse)").matches,
          item: rect(item),
          check: rect(item?.querySelector(".pdmux-files-check") ?? null),
          box: rect(item?.querySelector(".pdmux-files-checkbox") ?? null),
          name: rect(item?.querySelector(".pdmux-files-name") ?? null),
          button: rect(item?.querySelector(".pdmux-files-row") ?? null),
          host: rect(document.querySelector('[data-testid="files-host"]')),
          count: rect(document.querySelector('[data-testid="files-selection"]')),
          shows: [...document.querySelectorAll<HTMLElement>("[data-pdmux-count]")]
            .filter((node) => getComputedStyle(node).display !== "none")
            .map((node) => `${node.dataset.pdmuxCount}:${node.textContent}`),
          headerOverflow: header.scrollWidth - header.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      console.log(`TC-PDFILE-011 ${width}px ${JSON.stringify(geometry)}`);
      await testInfo.attach(`checkbox-geometry-${width}`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
      expect(geometry.coarse).toBe(touch);
      expect(geometry.pageOverflow).toBeLessThanOrEqual(0);
      expect(geometry.headerOverflow).toBeLessThanOrEqual(0);
      // ⚠ THE HOST PICKER KEEPS ITS NAME WHILE SOMETHING IS SELECTED. The words "N selected"
      // took it to 64px ("T…") on a phone; a narrow toolbar now shows the number alone.
      expect(geometry.host?.width ?? 0).toBeGreaterThanOrEqual(100);
      expect(geometry.shows).toEqual([touch ? "short:2" : "full:3 selected"]);
      expect(geometry.name?.width ?? 0).toBeGreaterThan(90);
      expect((geometry.box?.x ?? 0) + (geometry.box?.width ?? 0)).toBeLessThanOrEqual(geometry.button?.x ?? 0);
      if (touch) {
        // A fingertip's target: the box's cell and the name are each a full 32px row.
        expect(geometry.check?.height ?? 0).toBeGreaterThanOrEqual(32);
        expect(geometry.button?.height ?? 0).toBeGreaterThanOrEqual(32);
      }
      await page.screenshot({ path: testInfo.outputPath(`files-checkbox-select-${width}.png`), fullPage: true, animations: "disabled" });

      // The name keeps doing what it did: a folder opens.
      await press(row(page, "folder").locator(".pdmux-files-row"));
      await expect(page.locator('[data-pdmux-crumb="destination/folder"]')).toHaveAttribute("aria-current", "location");
      // ⚠ AND THE SELECTION STAYS BEHIND. It names entries of `destination`; carried into
      // `destination/folder` it would name files that are not there. The count says so by
      // leaving with it.
      await expect(page.getByTestId("files-selection-count")).toHaveCount(0);
      await expect(page.getByTestId("files-download")).toBeDisabled();
    });

    test(`[TC-PDFILE-011] select-all downloads every entry, and the clear control or Escape drops it at ${width}px`, async ({ page }): Promise<void> => {
      await fixture(page);
      await page.goto("/");
      const all = selectAll(page);
      await press(box(page, "file.txt"));
      await expect(all).toHaveJSProperty("indeterminate", true);
      await expect(all).not.toBeChecked();
      await press(all);
      for (const name of ["folder", "file.txt", "notes.md"]) await expect(box(page, name)).toBeChecked();
      await expect(all).toBeChecked();
      await expect(all).toHaveJSProperty("indeterminate", false);
      await expectSelected(page, 3);

      await press(page.getByTestId("files-clear-selection"));
      await expect(page.getByTestId("files-selection-count")).toHaveCount(0);
      for (const name of ["folder", "file.txt", "notes.md"]) await expect(box(page, name)).not.toBeChecked();
      await expect(page.getByTestId("files-download")).toBeDisabled();

      if (!touch) {
        // Escape drops the selection from anywhere in the panel — here, the box just clicked…
        await box(page, "notes.md").click();
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("files-selection-count")).toHaveCount(0);
        await expect(box(page, "notes.md")).not.toBeChecked();
        // …but not from the path field, where Escape already means "stop editing".
        await box(page, "notes.md").click();
        await page.getByTestId("files-path-edit").click();
        await page.getByTestId("files-path-input").press("Escape");
        await expect(page.getByTestId("files-path-input")).toHaveCount(0);
        await expectSelected(page, 1);
        await page.getByTestId("files-clear-selection").click();
      }

      await press(all);
      const created = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/file-transfers"));
      await press(page.getByTestId("files-download"));
      expect((await created).postDataJSON()).toMatchObject({ direction: "download", basePath: "destination", selection: ["folder", "file.txt", "notes.md"] });
    });

    test(`[TC-PDFILE-011] an older agent allows folder selection for deletion but explains unsupported downloads at ${width}px`, async ({ page }, testInfo): Promise<void> => {
      await fixture(page);
      const posts: string[] = [];
      page.on("request", (request): void => {
        if (request.method() === "POST" && request.url().includes("/file-transfers")) posts.push(request.url());
      });
      await page.goto("/?legacy");
      await expect(box(page, "folder")).toBeEnabled();
      await press(selectAll(page));
      for (const name of ["folder", "file.txt", "notes.md"]) await expect(box(page, name)).toBeChecked();
      await expectSelected(page, 3);
      await expect(page.getByTestId("files-delete")).toBeEnabled();
      await expect(page.getByTestId("files-download")).toBeDisabled();
      await expect(page.getByTestId("files-download")).toHaveAttribute("title", UPGRADE);
      await press(box(page, "folder"));
      await expectSelected(page, 2);
      await page.screenshot({ path: testInfo.outputPath(`files-checkbox-legacy-${width}.png`), fullPage: true, animations: "disabled" });

      // Files download one by one, in their own format, on the route every agent has.
      const saved: string[] = [];
      page.on("download", (download): void => { saved.push(download.suggestedFilename()); });
      await press(page.getByTestId("files-download"));
      await expect.poll(() => saved.length).toBe(2);
      expect(saved.sort()).toEqual(["file.txt", "notes.md"]);
      expect(posts).toEqual([]);
      // The folder still opens by its name — selection and navigation are separate.
      await press(row(page, "folder").locator(".pdmux-files-row"));
      await expect(page.locator('[data-pdmux-crumb="destination/folder"]')).toHaveAttribute("aria-current", "location");
    });
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
    await details(page);
    const progress = page.getByTestId("transfer-job").getByRole("progressbar");
    await expect(progress).toHaveAttribute("aria-valuenow", /49\./);
    await closeDetails(page);
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
    await details(page);
    await page.getByTestId("transfer-job").getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "paused");
    state.release();
    await expect.poll(() => state.entries.find((entry) => entry.kind === "file")?.offset).toBe(2 * 1_048_576);
    await page.reload();
    await details(page);
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "paused");
    await page.getByTestId("transfer-job").getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByTestId("transfer-reselect").getByRole("button", { name: "Upload folder", exact: true }).click();
    await expect.poll(() => state.jobs[0]?.state).toBe("completed");
    await details(page, "history");
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "completed");
    expect(state.chunks).toEqual([1_048_576, 1_048_576, 7]);
    await page.reload();
    await details(page, "history");
    await expect(page.getByTestId("transfer-job")).toHaveAttribute("data-transfer-state", "completed");
  });
}

test("[TC-PDFILE-014] an upload waits out 429 and 503 answers and finishes without pausing", async ({ page }, testInfo): Promise<void> => {
  const state = await fixture(page, [{ status: 429, retryAfter: "1" }, { status: 503 }]);
  state.release();
  await page.goto("/");
  await page.getByTestId("files-upload-folder").click();
  await page.getByTestId("transfer-conflict").getByRole("button", { name: "Overwrite", exact: true }).click();
  await details(page);
  const job = page.getByTestId("transfer-job");
  await expect.poll(() => state.chunkRequests.length).toBeGreaterThanOrEqual(1);
  // While it waits, the transfer still reads as running, not paused or failed.
  await expect(job).toHaveAttribute("data-transfer-state", "running");
  await expect(page.getByTestId("file-transfer-panel").getByRole("alert")).toHaveCount(0);
  await expect.poll(() => state.jobs[0]?.state, { timeout: 15_000 }).toBe("completed");
  await details(page, "history");
  await expect(job).toHaveAttribute("data-transfer-state", "completed");
  expect(state.chunks).toEqual([1_048_576, 1_048_576, 7]);
  expect(state.controls).toEqual(["start"]);
  const [refused, unavailable, accepted] = state.chunkRequests;
  expect([refused?.status, unavailable?.status, accepted?.status]).toEqual([429, 503, 200]);
  // Retry-After: 1, then the doubled backoff for the second refusal in a row.
  const gaps = { afterRateLimit: (unavailable?.at ?? 0) - (refused?.at ?? 0), afterUnavailable: (accepted?.at ?? 0) - (unavailable?.at ?? 0) };
  expect(gaps.afterRateLimit).toBeGreaterThanOrEqual(1_000);
  expect(gaps.afterUnavailable).toBeGreaterThanOrEqual(2_000);
  await testInfo.attach("retry-gaps", { body: JSON.stringify(gaps), contentType: "application/json" });
});

for (const width of [1280, 390]) {
  test(`[TC-PDFILE-015] a refused upload shows how long it waits before retrying at ${width}px`, async ({ page }, testInfo): Promise<void> => {
    await page.setViewportSize({ width, height: 844 });
    const state = await fixture(page, [{ status: 429, retryAfter: "4" }]);
    state.release();
    await page.goto("/");
    await page.getByTestId("files-upload-folder").click();
    await page.getByTestId("transfer-conflict").getByRole("button", { name: "Overwrite", exact: true }).click();
    await details(page);
    const job = page.getByTestId("transfer-job");
    const waiting = job.getByTestId("transfer-retry");
    await expect(waiting).toBeVisible();
    await expect(waiting).toHaveText(/^\s*Waiting to retry · [34] s · Upload$/);
    await expect(job).toHaveAttribute("data-transfer-state", "running");
    const seconds = async (): Promise<number> => Number(/· (\d+) s/.exec(await waiting.innerText())?.[1]);
    const first = await seconds();
    await expect.poll(seconds, { timeout: 3_000 }).toBeLessThan(first);

    // The waiting line takes the status line's place inside the row and the panel.
    const geometry = await page.evaluate(() => {
      const box = (element: Element | null): { x: number; y: number; width: number; height: number } | null => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      const row = document.querySelector('[data-testid="transfer-job"]');
      return {
        line: box(document.querySelector('[data-testid="transfer-retry"]')),
        row: box(row),
        panel: box(document.querySelector('[data-testid="file-transfer-panel"]')),
        rowOverflow: row ? row.scrollWidth - row.clientWidth : -1,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(geometry.line?.height ?? 0).toBeGreaterThan(0);
    expect((geometry.line?.x ?? 0) + (geometry.line?.width ?? 0)).toBeLessThanOrEqual((geometry.row?.x ?? 0) + (geometry.row?.width ?? 0) + 1);
    expect(geometry.rowOverflow).toBeLessThanOrEqual(0);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(0);
    await testInfo.attach("retry-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`transfer-retry-${width}.png`), fullPage: true, animations: "disabled" });

    // The retry starts: the line goes and the transfer finishes without pausing.
    await expect(waiting).toHaveCount(0, { timeout: 6_000 });
    await expect.poll(() => state.jobs[0]?.state).toBe("completed");
    await details(page, "history");
    await expect(job).toHaveAttribute("data-transfer-state", "completed");
    expect(state.controls).toEqual(["start"]);
    await page.screenshot({ path: testInfo.outputPath(`transfer-retry-${width}-done.png`), fullPage: true, animations: "disabled" });
  });
}

for (const width of [1280, 390]) {
  test(`[TC-PDFILE-021] a refused chunk pauses and names its code under the generic reason at ${width}px`, async ({ page }, testInfo): Promise<void> => {
    await page.setViewportSize({ width, height: 844 });
    // What a desktop relay that dropped the chunk headers answered (#30).
    const state = await fixture(page, [{ status: 400, code: "FILES_TRANSFER_CHUNK" }]);
    state.release();
    await page.goto("/");
    await page.getByTestId("files-upload-folder").click();
    await page.getByTestId("transfer-conflict").getByRole("button", { name: "Overwrite", exact: true }).click();
    await expect.poll(() => state.controls).toEqual(["start", "pause"]);
    await details(page);
    const alert = page.getByTestId("transfer-list").getByRole("alert");
    await expect(alert).toContainText("The transfer stopped. Retry or select the original source again.");
    const code = alert.getByTestId("transfer-error-code");
    await expect(code).toHaveText("Error code: FILES_TRANSFER_CHUNK");

    const geometry = await page.evaluate(() => {
      const box = (element: Element | null): { x: number; y: number; width: number; height: number } | null => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      const list = document.querySelector('[data-testid="transfer-list"]');
      const code = document.querySelector('[data-testid="transfer-error-code"]');
      return {
        reason: box(code?.previousElementSibling ?? null),
        code: box(code),
        list: box(list),
        listOverflow: list ? list.scrollWidth - list.clientWidth : -1,
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(geometry.code?.height ?? 0).toBeGreaterThan(0);
    // Under the sentence it qualifies, inside the list, and never wider than it.
    expect(geometry.code?.y ?? 0).toBeGreaterThanOrEqual((geometry.reason?.y ?? 0) + (geometry.reason?.height ?? 0));
    expect((geometry.code?.x ?? 0) + (geometry.code?.width ?? 0)).toBeLessThanOrEqual((geometry.list?.x ?? 0) + (geometry.list?.width ?? 0) + 1);
    expect(geometry.listOverflow).toBeLessThanOrEqual(0);
    expect(geometry.pageOverflow).toBeLessThanOrEqual(0);
    await testInfo.attach("error-code-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`transfer-error-code-${width}.png`), fullPage: true, animations: "disabled" });
  });
}

test("[TC-PDFILE-021] a code with its own sentence is not repeated as a code", async ({ page }): Promise<void> => {
  const state = await fixture(page, [{ status: 400, code: "FILES_TRANSFER_SOURCE_CHANGED" }]);
  state.release();
  await page.goto("/");
  await page.getByTestId("files-upload-folder").click();
  await page.getByTestId("transfer-conflict").getByRole("button", { name: "Overwrite", exact: true }).click();
  await expect.poll(() => state.controls).toEqual(["start", "pause"]);
  await details(page);
  await expect(page.getByTestId("transfer-list").getByRole("alert")).toContainText("The selected source differs");
  await expect(page.getByTestId("transfer-error-code")).toHaveCount(0);
});

test.describe("checkbox contrast at 390px", (): void => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: devices["Pixel 7"].userAgent });

  for (const theme of ["light", "dark"] as const) {
    test(`[TC-PDUI-232] unchecked file and folder boxes remain visible and selectable, ${theme}`, async ({ page }, testInfo): Promise<void> => {
      await fixture(page);
      await page.goto("/?legacy");
      // The app switches theme with a class on the document (mode-watcher); the package's code
      // palette follows the OS query. A dark device sets both, so the shot does too.
      if (theme === "dark") {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.evaluate(() => document.documentElement.classList.add("dark"));
      }
      await box(page, "file.txt").tap();
      await expect(box(page, "file.txt")).toBeChecked();

      const unchecked = await boxContrast(page, "notes.md");
      const folder = await boxContrast(page, "folder");
      const checked = await boxContrast(page, "file.txt");
      console.log(`TC-PDUI-232 ${theme} ${JSON.stringify({ unchecked, folder, checked })}`);
      await testInfo.attach(`checkbox-contrast-${theme}`, { body: JSON.stringify({ unchecked, folder, checked }, null, 2), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath(`files-checkbox-${theme}-390.png`), fullPage: true, animations: "disabled" });

      // WCAG 1.4.11: a control's boundary needs 3:1 against what is next to it — the row,
      // and the row under a pointer.
      expect(unchecked.ratio).toBeGreaterThanOrEqual(3);
      expect(unchecked.hoverRatio).toBeGreaterThanOrEqual(3);
      expect(unchecked.borderStyle).toBe("solid");
      expect(unchecked.opacity).toBe(1);
      expect(folder.borderStyle).toBe("solid");
      expect(folder.opacity).toBe(1);
      expect(folder.cursor).toBe("pointer");
      // Checked is untouched: filled with the primary colour, solid, opaque.
      expect(checked.borderStyle).toBe("solid");
      expect(checked.opacity).toBe(1);
      expect(checked.fill).not.toBe(unchecked.fill);
    });
  }
});

/**
 * The explorer's names, read against their own rows.
 *
 * ⚠ THE APP'S PALETTE, NOT THE PACKAGE'S FALLBACK. Here the card comes from the app's
 * `--card`, which follows mode-watcher's class, while the name colours come from the
 * package. That split is exactly how a dark app on a light OS ended up with `#0550ae`
 * folder names on a near-black card.
 */
async function nameContrast(page: Page): Promise<{ card: number; names: { kind: string; color: string; ratio: number }[] }> {
  return page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((animation) => animation.finished));
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = "#000";
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: [number, number, number, number], base: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => top[i]! * top[3] + base[i]! * (1 - top[3])) as [number, number, number];
    const backdrop = (node: Element | null): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let element = node; element; element = element.parentElement) {
        const colour = rgba(getComputedStyle(element).backgroundColor);
        if (colour[3] > 0) layers.push(colour);
        if (colour[3] >= 1) break;
      }
      return layers.reverse().reduce<[number, number, number]>((base, layer) => over(layer, base), [255, 255, 255]);
    };
    const luminance = ([r, g, b]: [number, number, number]): number => {
      const channel = (value: number): number => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a: [number, number, number], b: [number, number, number]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };
    const names = [...document.querySelectorAll<HTMLElement>("[data-pdmux-entry]")].map((item) => {
      const name = item.querySelector(".pdmux-files-name") as HTMLElement;
      const row = backdrop(item);
      return { kind: item.dataset.pdmuxEntry ?? "", color: getComputedStyle(name).color, ratio: ratio(over(rgba(getComputedStyle(name).color), row), row) };
    });
    return { card: Math.round(luminance(backdrop(document.querySelector("[data-pdmux-files-body]"))) * 1000) / 1000, names };
  });
}

for (const width of [1280, 390]) {
  test.describe(`the app's theme class at ${width}px`, (): void => {
    test.use({ viewport: { width, height: 844 }, ...(width === 390 ? { hasTouch: true, isMobile: true, userAgent: devices["Pixel 7"].userAgent } : {}) });

    for (const theme of [{ html: "dark", os: "light" }, { html: "light", os: "dark" }] as const) {
      // The light-class case is the mirror image and needs no second screenshot width.
      if (theme.html === "light" && width !== 390) continue;
      test(`[TC-PDUI-233] the explorer follows the app's .${theme.html} class on a ${theme.os} OS at ${width}px`, async ({ page }, testInfo): Promise<void> => {
        await page.emulateMedia({ colorScheme: theme.os });
        await fixture(page);
        await page.goto("/");
        // mode-watcher puts the resolved mode on <html>: `dark`, or `light` (lightClassNames).
        await page.evaluate((name) => document.documentElement.classList.add(name), theme.html);
        const tap = (target: Locator): Promise<void> => (width === 390 ? target.tap() : target.click());
        await tap(box(page, "file.txt"));
        await expect(box(page, "file.txt")).toBeChecked();
        const palette = await nameContrast(page);
        const unchecked = await boxContrast(page, "notes.md");
        const checked = await boxContrast(page, "file.txt");
        const result = { palette, unchecked: unchecked.ratio, checked: checked.ratio };
        console.log(`TC-PDUI-233 .${theme.html} on ${theme.os} OS ${width}px ${JSON.stringify(result)}`);
        await testInfo.attach("theme-contrast", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
        if (theme.html === "dark") {
          await page.screenshot({ path: testInfo.outputPath(`files-dark-class-${width}.png`), fullPage: true, animations: "disabled" });
        }
        if (theme.html === "dark") expect(palette.card).toBeLessThan(0.05);
        else expect(palette.card).toBeGreaterThan(0.8);
        expect(palette.names.length).toBe(3);
        for (const name of palette.names) expect(name.ratio, `${name.kind} (${name.color})`).toBeGreaterThanOrEqual(4.5);
        expect(unchecked.ratio).toBeGreaterThanOrEqual(3);
        expect(checked.ratio).toBeGreaterThanOrEqual(3);
      });
    }
  });
}


for (const width of [1280, 390]) {
  test.describe(`preview and batch operations at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, ...(width === 390 ? { isMobile: true, hasTouch: true, userAgent: devices["Pixel 7"].userAgent } : {}) });
    test("[TC-PDFILE-018] renders Markdown and source without rereading, text fallback, PDF and media", async ({ page }, info) => {
      await fixture(page);
      const reads: string[] = [];
      page.on("request", request => { if (request.url().includes("/files/content")) reads.push(request.url()); });
      await page.goto("/?previews");
      await row(page, "notes.md").locator("button").click();
      await expect(page.getByTestId("markdown-preview").getByRole("heading", { name: "Preview guide" })).toBeVisible();
      await expect(page.getByTestId("markdown-preview").locator("table")).toBeVisible();
      expect(await page.evaluate(() => "previewExecuted" in window)).toBe(false);
      await page.getByRole("tab", { name: "Source", exact: true }).click();
      await expect(page.locator("[data-pdmux-files-preview] pre.pdmux-blob-code")).toContainText("# Preview guide");
      await page.getByRole("tab", { name: "Preview", exact: true }).click();
      expect(reads).toHaveLength(1);
      await page.screenshot({ path: info.outputPath("markdown.png"), fullPage: true });
      await row(page, "app.log").locator("button").click();
      await expect(page.locator("[data-pdmux-files-preview] pre.pdmux-blob-code")).toContainText("INFO ready");
      await row(page, "sound.wav").locator("button").click();
      const audio = page.getByTestId("file-preview-audio");
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.duration)).toBe(2);
      await audio.evaluate(async (element: HTMLAudioElement) => { await element.play(); element.currentTime = 1; });
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(1);
      await audio.evaluate((element: HTMLAudioElement) => element.pause());
      await row(page, "clip.webm").locator("button").click();
      const video = page.getByTestId("file-preview-video");
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
      await video.evaluate(async (element: HTMLVideoElement) => { await element.play(); element.currentTime = .5; });
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThanOrEqual(.5);
      await video.evaluate((element: HTMLVideoElement) => element.pause());
      await page.screenshot({ path: info.outputPath("video.png"), fullPage: true });
      await row(page, "paper.pdf").locator("button").click();
      if (await page.evaluate(() => navigator.pdfViewerEnabled)) await expect(page.getByTestId("file-preview-pdf")).toBeVisible();
      else await expect(page.getByTestId("file-preview-fallback")).toBeVisible();
      await page.screenshot({ path: info.outputPath("pdf.png"), fullPage: true });
      await row(page, "bundle.zip").locator("button").click();
      await expect(page.getByTestId("file-preview-fallback").getByRole("link", { name: "Download" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
    test("[TC-PDFILE-019] deletes a mixed selection once and retains failed targets", async ({ page }) => {
      await fixture(page);
      let remaining = ["folder", "file.txt", "notes.md"];
      const deleted: string[] = [];
      await page.route("**/api/hosts/**/files?**", async route => {
        const request = route.request(); const path = new URL(request.url()).searchParams.get("path") ?? "";
        if (request.method() === "DELETE") {
          deleted.push(path);
          if (path.endsWith("notes.md")) await route.fulfill({ json: { removed: 0, error: "Permission denied" } });
          else { remaining = remaining.filter(name => !path.endsWith("/" + name)); await route.fulfill({ json: { removed: 1, error: null } }); }
        } else await route.fulfill({ json: { path, home: "/home/example", entries: remaining.map(name => ({ name, dir: name === "folder", symlink: false, size: 7, mode: 0o600, modified: 1 })), dropped: 0, truncated: false, error: null } });
      });
      await page.goto("/"); await selectAll(page).click();
      await page.getByTestId("files-delete").click();
      await page.getByTestId("files-delete-confirm-confirm").click();
      await expect(page.getByTestId("files-delete-confirm")).toContainText("2 deleted · 1 failed");
      expect(deleted).toEqual(["destination/folder", "destination/file.txt", "destination/notes.md"]);
      await page.getByTestId("files-delete-confirm").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(box(page, "notes.md")).toBeChecked(); await expectSelected(page, 1);
    });
  });
}

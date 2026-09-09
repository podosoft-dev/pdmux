import { expect, test, type Page } from "@playwright/test";
import { e2eAdminState } from "../helpers/accounts";
import { readLayout, writeLayout } from "../helpers/pdmux-layout";
import { boxFacts, expectOnScreen } from "../helpers/geometry";
import { agentDownstreamSchema, agentUpstreamSchema, commitDetailSchema, gitTreeSchema, gitBlobSchema, workingDiffSchema } from "@pdmux/protocol";
import { WebSocket } from "ws";
import { UNCOMMITTED } from "@pdmux/core";
import english from "../../apps/web/src/lib/i18n/catalogs/app/en.json";
import { graphSnapshot, repository, NEW_SHA, OLD_SHA } from "../../apps/web/test/fixtures/git-snapshot";
import type { RepoGraphResponse } from "../../apps/web/src/lib/dashboard/types";

// The live-ingest case mints a one-time agent credential; never archive it in a trace.
test.use({ storageState: e2eAdminState, trace: "off" });

interface Fixture {
  graph: RepoGraphResponse;
  collects: number;
  reads: number;
  treeReads: number;
  blobReads: number;
  detailReads: number;
  failure: string | null;
  working: ReturnType<typeof workingDiffSchema.parse> | null;
}

async function mockGit(page: Page): Promise<Fixture> {
  const state: Fixture = { graph: graphSnapshot(), collects: 0, reads: 0,
    treeReads: 0, blobReads: 0, detailReads: 0, failure: null, working: null };
  await page.route("**/api/hosts/*/repos", (route) => route.fulfill({ json: [state.graph.repo] }));
  await page.route("**/api/hosts/*/repos/*", (route) => {
    state.reads += 1;
    return route.fulfill({ json: state.graph });
  });
  await page.route("**/api/hosts/*/collect", (route) => {
    state.collects += 1;
    if (state.failure) return route.fulfill({ status: 409,
      json: { success: false, error: { code: state.failure, message: "Unavailable", statusCode: 409 } } });
    return route.fulfill({ json: { hostId: "h1", what: "repos" } });
  });
  await page.route("**/api/hosts/*/repos/*/working-diff", (route) => route.fulfill({
    json: { available: state.working !== null, pending: 0, detail: state.working },
  }));
  await page.route("**/api/hosts/*/repos/*/commits/*/detail", (route) => {
    state.detailReads += 1;
    return route.fulfill({ json: { available: true, pending: 0,
      detail: commitDetailSchema.parse({ sha: OLD_SHA, body: "Original detail" }) } });
  });
  await page.route("**/api/hosts/*/repos/*/commits/*/tree", (route) => {
    state.treeReads += 1;
    return route.fulfill({ json: { available: true, pending: 0,
      detail: gitTreeSchema.parse({ sha: OLD_SHA, entries: [{ path: "README.md", size: 12 }] }) } });
  });
  await page.route("**/api/hosts/*/repos/*/commits/*/blob**", (route) => {
    state.blobReads += 1;
    return route.fulfill({ json: { available: true, pending: 0,
      detail: gitBlobSchema.parse({ sha: OLD_SHA, path: "README.md", lines: ["Keep this file open"] }) } });
  });
  return state;
}

async function inDock(page: Page, state: Fixture, run: () => Promise<void>): Promise<void> {
  const saved = await readLayout(page.request);
  if (!saved) throw new Error("The isolated test account needs a saved layout");
  const response = await page.request.get("/api/hosts");
  expect(response.ok()).toBeTruthy();
  const hosts = await response.json() as { id: string }[];
  const host = hosts[0];
  if (!host) throw new Error("The isolated test account needs a host");
  state.graph = graphSnapshot(repository({ hostId: host.id }));
  try {
    await writeLayout(page.request, { ...saved, payload: { ...saved.payload,
      slots: [], dockOpen: true, filesOpen: false, dockWidth: 520, dockRefsHidden: false,
      dockTarget: { hostId: host.id, repo: state.graph.repo.id } } });
    await page.goto("/");
    await page.locator('html[data-hydrated="true"]').waitFor();
    await run();
  } finally {
    // Unmount the shell so a debounced save cannot overwrite the restore.
    await page.goto(`/git/h1/${state.graph.repo.id}`);
    await writeLayout(page.request, saved);
  }
}

test("[TC-PDGIT-052] a detached dock reads the result after the collect POST", async ({ page }, testInfo) => {
  const state = await mockGit(page);
  await page.goto(`/git/h1/${state.graph.repo.id}`);
  await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
  const list = page.locator(".pdmux-graph-list");
  const before = await list.boundingBox();
  expect(before?.width).toBeGreaterThan(100);
  await page.screenshot({ path: testInfo.outputPath("before-refresh.png") });
  await page.getByTestId("dock-rescan").click();
  await expect.poll(() => state.collects).toBe(1);
  // The POST has already returned. Only a later read can see this snapshot.
  state.graph = graphSnapshot(repository({ headSha: NEW_SHA, dirtyCount: 2,
    lastSnapshotAt: "2026-09-07T00:01:00.000Z" }));
  await expect(page.locator(`[data-pdmux-sha='${NEW_SHA}']`)).toBeVisible({ timeout: 12_000 });
  await expect(page.getByTestId("dock-freshness")).toHaveAttribute("title", state.graph.repo.lastSnapshotAt ?? "");
  await expect(page.getByTestId("dock-rescan")).toBeEnabled();
  expect((await list.boundingBox())?.width).toBe(before?.width);
  await page.screenshot({ path: testInfo.outputPath("after-refresh.png") });
});

for (const surface of ["docked", "detached"] as const) {
  test(`[TC-PDGIT-052] ${surface} refresh keeps the selected file and updates remote refs`, async ({ page }, testInfo) => {
    const state = await mockGit(page);
    const verify = async (): Promise<void> => {
      const oldRow = page.locator(`[data-pdmux-sha='${OLD_SHA}']`);
      await expect(oldRow).toBeVisible();
      await oldRow.click();
      await page.getByTestId("detail-tab-tree").click();
      await page.locator("[data-pdmux-file-row='README.md']").click();
      const blob = page.locator("[data-pdmux-blob='README.md']");
      await expect(blob).toContainText("Keep this file open");
      const before = await boxFacts(page.locator(".pdmux-graph-list"));
      await page.screenshot({ path: testInfo.outputPath(`${surface}-before.png`) });
      await page.getByTestId("dock-rescan").click();
      await expect.poll(() => state.collects).toBe(1);
      state.graph = graphSnapshot({ ...state.graph.repo, headSha: NEW_SHA, dirtyCount: 3 });
      await expect(page.locator(`[data-pdmux-sha='${NEW_SHA}']`)).toBeVisible({ timeout: 12_000 });
      await expect(oldRow).toHaveAttribute("aria-current", "true");
      await expect(page.getByTestId("detail-tab-tree")).toHaveAttribute("data-state", "active");
      await expect(blob).toContainText("Keep this file open");
      await page.getByTestId("dock-remote").click();
      await expect.poll(() => state.collects).toBe(2);
      state.graph = { ...state.graph, repo: { ...state.graph.repo,
        remoteRefs: [{ name: "main", sha: "c".repeat(40), kind: "branch" }],
        remoteCheckedAt: "2026-09-07T01:00:00.000Z" } };
      await expect(page.getByTestId("dock-remote-row")).toHaveCount(1);
      await expect(page.getByTestId("dock-remote")).toBeEnabled();
      await expect(blob).toContainText("Keep this file open");
      expect([state.detailReads, state.treeReads, state.blobReads]).toEqual([1, 1, 1]);
      const after = await boxFacts(page.locator(".pdmux-graph-list"));
      expect(after.width).toBe(before.width);
      expect(after.height).toBeGreaterThan(80);
      await expectOnScreen(page.locator(".pdmux-graph-list"));
      await page.screenshot({ path: testInfo.outputPath(`${surface}-after.png`) });
      await testInfo.attach("graph-geometry", { body: JSON.stringify({ before, after }), contentType: "application/json" });
    };
    if (surface === "docked") await inDock(page, state, verify);
    else {
      await page.goto(`/git/h1/${state.graph.repo.id}`);
      await verify();
    }
  });
}

test("[TC-PDGIT-052] periodic refresh reads data that arrives after its timestamp", async ({ page }) => {
  const state = await mockGit(page);
  await page.goto(`/git/h1/${state.graph.repo.id}`);
  await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
  state.graph = graphSnapshot(repository({ lastSnapshotAt: "2026-09-07T01:00:00.000Z" }));
  await expect(page.getByTestId("dock-freshness")).toHaveAttribute("title", state.graph.repo.lastSnapshotAt ?? "", { timeout: 12_000 });
  // Ingest can publish the timestamp before the graph. Do not freeze on that timestamp.
  state.graph = graphSnapshot({ ...state.graph.repo, headSha: NEW_SHA });
  await expect(page.locator(`[data-pdmux-sha='${NEW_SHA}']`)).toBeVisible({ timeout: 12_000 });
  expect(state.collects).toBe(0);
});

test("[TC-PDGIT-052] an open working diff refreshes and clears when the tree is clean", async ({ page }) => {
  const state = await mockGit(page);
  state.graph = graphSnapshot(repository({ dirtyCount: 1, hasWorkingDiff: true }));
  state.working = workingDiffSchema.parse({ unstaged: [{ path: "old.ts", status: "M", lines: ["+old"] }] });
  await page.goto(`/git/h1/${state.graph.repo.id}`);
  await page.locator(`[data-pdmux-sha='${UNCOMMITTED}']`).click();
  await expect(page.locator("[data-pdmux-tabpanel='changes']")).toContainText("old.ts");
  state.working = workingDiffSchema.parse({ unstaged: [{ path: "new.ts", status: "M", lines: ["+new"] }] });
  await expect(page.locator("[data-pdmux-tabpanel='changes']")).toContainText("new.ts", { timeout: 12_000 });
  state.working = null;
  state.graph = graphSnapshot(repository());
  await expect(page.locator("[data-pdmux-tabpanel='changes']").getByText("new.ts")).toHaveCount(0, { timeout: 12_000 });
  await expect(page.locator(`[data-pdmux-sha='${UNCOMMITTED}']`)).toHaveCount(0);
  await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
});

test("[TC-PDGIT-052] offline and timeout outcomes keep the last graph and allow retry", async ({ page }) => {
  const state = await mockGit(page);
  await page.goto(`/git/h1/${state.graph.repo.id}`);
  await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
  state.failure = "HOST_OFFLINE";
  await page.getByTestId("dock-rescan").click();
  await expect(page.getByTestId("dock-refresh-error")).toHaveText(english.dash.agent.offline);
  await expect(page.getByTestId("dock-rescan")).toBeEnabled();
  await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
  state.failure = null;
  // Control only browser timers; no server time or real account state is changed.
  await page.clock.install();
  await page.getByTestId("dock-rescan").click();
  await expect.poll(() => state.collects).toBe(2);
  await page.clock.fastForward(60_001);
  await expect(page.getByTestId("dock-refresh-error")).toContainText("one minute");
  await expect(page.getByTestId("dock-rescan")).toBeEnabled();
  await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
});

test("[TC-PDGIT-052] hidden browser documents stop reading and resume immediately", async ({ page }) => {
  const state = await mockGit(page);
  await page.goto(`/git/h1/${state.graph.repo.id}`);
  await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(200);
  const reads = state.reads;
  await page.waitForTimeout(5_500);
  expect(state.reads).toBe(reads);
  state.graph = graphSnapshot(repository({ headSha: NEW_SHA }));
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator(`[data-pdmux-sha='${NEW_SHA}']`)).toBeVisible({ timeout: 3_000 });
});

test("[TC-PDGIT-052] a stacked dock reads only on the Git tab", async ({ page }) => {
  const state = await mockGit(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await inDock(page, state, async () => {
    await page.getByTestId("shell-tab-git").click();
    await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
    await page.getByTestId("shell-tab-terminal").click();
    await page.waitForTimeout(200);
    const reads = state.reads;
    await page.waitForTimeout(5_500);
    expect(state.reads).toBe(reads);
    state.graph = graphSnapshot({ ...state.graph.repo, headSha: NEW_SHA });
    await page.getByTestId("shell-tab-git").click();
    await expect(page.locator(`[data-pdmux-sha='${NEW_SHA}']`)).toBeVisible({ timeout: 3_000 });
  });
});

test.describe("real snapshot ingestion", () => {
  test("[TC-PDGIT-052] collection and periodic frames reach the UI through the real API", async ({ page, request, baseURL }) => {
    const created = await request.post("/api/hosts", { data: { label: `e2e-git-refresh-${Date.now()}` } });
    expect(created.ok(), "create an isolated test host").toBeTruthy();
    const { id: hostId } = await created.json() as { id: string };
    let socket: WebSocket | null = null;
    try {
      const minted = await request.post(`/api/hosts/${hostId}/tokens`, { data: { name: "git-refresh-test" } });
      expect(minted.ok(), "mint an ephemeral test credential").toBeTruthy();
      const { token } = await minted.json() as { token: string };
      const url = new URL("/agent/ws", baseURL);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url, { headers: { "x-api-key": token } });
      const agent = socket;
      const epoch = Math.floor(Date.now() / 1000);
      let welcomed = false;
      let collections = 0;
      let socketError = false;
      const send = (value: unknown): void => { agent.send(JSON.stringify(agentUpstreamSchema.parse(value))); };
      const snapshot = (sha: string, ts: number): void => {
        const shas = sha === OLD_SHA ? [OLD_SHA] : [sha, OLD_SHA];
        send({ type: "repos", ts, repos: [{ path: "/work/repo", name: "repo", ts,
          head: { branch: "main", sha }, refs: [{ name: "main", kind: "local", sha }],
          commits: shas.map((value, index) => ({ sha: value, parents: shas.slice(index + 1),
            subject: value === OLD_SHA ? "Original commit" : "Newly collected commit", date: ts })),
        }] });
      };
      agent.on("error", () => { socketError = true; });
      agent.on("open", () => send({ type: "hello", hello: { protocolVersion: 1, agentVersion: "0.12.3",
        hostname: "test-agent", os: "linux", arch: "amd64", capabilities: ["git"] } }));
      agent.on("message", (raw) => {
        const parsed = agentDownstreamSchema.safeParse(JSON.parse(raw.toString()) as unknown);
        if (!parsed.success) return;
        const frame = parsed.data;
        if (frame.type === "welcome") { welcomed = true; snapshot(OLD_SHA, epoch); }
        if (frame.type === "ping") send({ type: "pong", ts: Math.floor(Date.now() / 1000) });
        if (frame.type === "collect") {
          collections += 1;
          if (frame.what === "repos") snapshot(NEW_SHA, epoch + 1);
          if (frame.what === "remote") send({ type: "repos", ts: epoch + 2, repos: [{
            path: "/work/repo", name: "repo", ts: epoch + 2, partial: true,
            remote: { checkedAt: epoch + 2, refs: [{ kind: "branch", name: "main", sha: "d".repeat(40) }] },
          }] });
        }
      });
      await expect.poll(() => welcomed && !socketError, { timeout: 10_000 }).toBe(true);
      let repoId = "";
      await expect.poll(async () => {
        const response = await request.get(`/api/hosts/${hostId}/repos`);
        const repos = await response.json() as { id: string }[];
        repoId = repos[0]?.id ?? "";
        return repoId;
      }).not.toBe("");
      await page.goto(`/git/${hostId}/${repoId}`);
      await expect(page.locator(`[data-pdmux-sha='${OLD_SHA}']`)).toBeVisible();
      await page.getByTestId("dock-rescan").click();
      await expect(page.locator(`[data-pdmux-sha='${NEW_SHA}']`)).toBeVisible({ timeout: 12_000 });
      await expect(page.getByTestId("dock-rescan")).toBeEnabled();
      await page.getByTestId("dock-remote").click();
      await expect(page.getByTestId("dock-remote-row")).toHaveCount(1, { timeout: 12_000 });
      await expect(page.getByTestId("dock-remote")).toBeEnabled();
      expect(collections).toBe(2);
      // No collect POST: a periodic agent frame still reaches an already-open panel.
      const periodicSha = "c".repeat(40);
      snapshot(periodicSha, epoch + 3);
      await expect(page.locator(`[data-pdmux-sha='${periodicSha}']`)).toBeVisible({ timeout: 12_000 });
      expect(collections).toBe(2);
    } finally {
      socket?.terminate();
      await page.goto("/login");
      const removed = await request.delete(`/api/hosts/${hostId}`);
      expect(removed.ok(), "remove only the disposable host and its credentials").toBeTruthy();
    }
  });
});

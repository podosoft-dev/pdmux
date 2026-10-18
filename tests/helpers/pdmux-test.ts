import { test as base, expect, type APIRequestContext, type PlaywrightWorkerArgs } from "@playwright/test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { E2E_OWNER, e2eOwnerState, e2eWorker, e2eWorkerState, withEnglishLocale } from "./pdmux-accounts";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5001";
const headers = { origin: baseURL };

type Playwright = PlaywrightWorkerArgs["playwright"];
type SessionView = { user?: { id?: string; email?: string }; session?: { activeOrganizationId?: string | null } } | null;

async function readSession(context: APIRequestContext): Promise<SessionView> {
  const response = await context.get("/api/auth/get-session");
  return response.ok() ? ((await response.json()) as SessionView) : null;
}

/** True when the saved session still belongs to `email` and is acting in `organizationId`. */
async function stillValid(playwright: Playwright, path: string, email: string, organizationId: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers, storageState: path });
  try {
    const session = await readSession(context);
    return session?.user?.email === email && session.session?.activeOrganizationId === organizationId;
  } finally {
    await context.dispose();
  }
}

/**
 * Signs worker `index` in as its own account, in the owner's organization, and returns the
 * path of its storage state.
 *
 * Created on first use rather than by the setup project, so a worker exists for every
 * `parallelIndex` the run actually has. Being created after the setup's user baseline, the
 * accounts are removed by the suite's `cleanup` project like any other account a run made,
 * and the next run creates them again. A run without that cleanup (`--no-deps`) reuses them.
 */
async function prepareWorker(playwright: Playwright, index: number): Promise<string> {
  const account = e2eWorker(index);
  const path = e2eWorkerState(index);
  if (!existsSync(e2eOwnerState)) {
    throw new Error(`${e2eOwnerState} is missing. Run the setup project once (a run without --no-deps).`);
  }
  const owner = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers, storageState: e2eOwnerState });
  const session = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers });
  try {
    const organizationId = (await readSession(owner))?.session?.activeOrganizationId;
    if (!organizationId) {
      throw new Error(
        `${e2eOwnerState} is not a session of ${E2E_OWNER.email} in its organization. ` +
          "Run the setup project once (a run without --no-deps).",
      );
    }
    if (await stillValid(playwright, path, account.email, organizationId)) return path;

    const credentials = { email: account.email, password: account.password };
    let signIn = await session.post("/api/auth/sign-in/email", { data: credentials });
    if (!signIn.ok()) {
      const created = await owner.post("/api/auth/admin/create-user", { data: { ...account, role: "admin" } });
      expect(created.ok(), `create ${account.email}: ${await created.text()}`).toBeTruthy();
      signIn = await session.post("/api/auth/sign-in/email", { data: credentials });
    }
    expect(signIn.ok(), `sign-in ${account.email}: ${await signIn.text()}`).toBeTruthy();
    const userId = (await readSession(session))?.user?.id;
    expect(userId, `session of ${account.email}`).toBeTruthy();

    const members = await owner.get("/api/auth/organization/list-members", {
      params: { organizationId, filterField: "userId", filterValue: userId as string },
    });
    expect(members.ok(), `list the members: ${await members.text()}`).toBeTruthy();
    if (((await members.json()) as { members: unknown[] }).members.length === 0) {
      const added = await owner.post("/api/account/org-member", {
        data: { organizationId, userId, role: "admin" },
      });
      expect(added.ok(), `add ${account.email} to the organization: ${await added.text()}`).toBeTruthy();
    }
    const active = await session.post("/api/auth/organization/set-active", { data: { organizationId } });
    expect(active.ok(), `act in the organization: ${await active.text()}`).toBeTruthy();
    expect((await session.post("/api/auth/revoke-other-sessions")).ok(), `clear old sessions of ${account.email}`).toBeTruthy();

    // The product's own answer to "whose fleet is this, and may I change it". Anything else
    // fails every spec that registers a host, with an error far from the cause.
    const scope = await session.get("/api/fleet/scope");
    expect(await scope.json(), `${account.email} manages the organization's fleet`).toEqual({
      personal: false,
      canManage: true,
    });

    await writeFile(path, `${JSON.stringify(withEnglishLocale(await session.storageState(), baseURL), null, 2)}\n`);
    return path;
  } finally {
    await session.dispose();
    await owner.dispose();
  }
}

/**
 * Gives the account a saved layout when it has none: the product's empty split.
 *
 * WHY: a worker account is new on most runs, and a new account has no layout row until its
 * first visit to the shell stores one. The specs that rearrange the grid read that row and put
 * it back, and some skip or fail without it, so which spec a worker happened to run first
 * decided what the others found.
 */
async function ensureLayout(playwright: Playwright, path: string): Promise<void> {
  const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: headers, storageState: path });
  try {
    const prefs = await context.get("/api/prefs");
    expect(prefs.ok(), `read the worker's prefs: ${await prefs.text()}`).toBeTruthy();
    if (((await prefs.json()) as { layouts?: unknown[] }).layouts?.length) return;
    const written = await context.put("/api/prefs/layouts/default", {
      data: { payload: { mode: "split4", page: 0, slots: [], zoomId: null, focusId: null }, isDefault: true },
    });
    expect(written.ok(), `seed the worker's layout: ${await written.text()}`).toBeTruthy();
  } finally {
    await context.dispose();
  }
}

/**
 * The `test` of every pdmux spec that runs as the suite's own accounts, one per worker.
 *
 * `e2eState` is the storage state of this worker's account; pages get it by default, and a
 * spec that opens its own context passes it (`storageState: e2eState`), in hooks too: it is
 * worker-scoped. `test.use` with another state still wins, so a block can run as `userState`.
 */
export const test = base.extend<object, { e2eState: string }>({
  e2eState: [
    async ({ playwright }, use, workerInfo) => {
      const path = await prepareWorker(playwright, workerInfo.parallelIndex);
      await ensureLayout(playwright, path);
      await use(path);
    },
    { scope: "worker" },
  ],
  storageState: async ({ e2eState }, use) => {
    await use(e2eState);
  },
});

/**
 * A terminal session name that belongs to the current worker, such as `pdmux-e2e-w0`.
 *
 * Sessions live on the one e2e host every worker shares. Two workers attached to one session
 * see and type into the same shell, and a mode one of them sets (copy-mode, mouse reporting)
 * reaches the other. Call it inside a test or a hook.
 */
export function workerSession(base = "pdmux-e2e"): string {
  return `${base}-w${test.info().parallelIndex}`;
}

export { expect };

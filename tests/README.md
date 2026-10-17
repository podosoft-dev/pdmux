# tests

End-to-end tests for this app, run with [`@playwright/test`](https://playwright.dev):

```bash
bun run test:e2e         # all specs (api + ui)
bun run test:e2e:api     # backend endpoints (request-only)
bun run test:e2e:ui      # pages (chromium)
bun run test:e2e:report  # open the HTML report
```

The suite runs against a live stack (web on `E2E_BASE_URL`, proxying `/api/*` to
the API). With the recommended containerized loop, start `podo dev watch` and run:

```bash
E2E_BASE_URL=http://pdmux.localhost bun run test:e2e
```

The default `http://localhost:5001` is for the alternative `bun run dev`
host-process loop. Files ending in `*.api.spec.ts` run in the request-only `api`
project; `*.ui.spec.ts` run in the chromium `ui` project; `*.mobile.spec.ts` run
in the `ui-mobile` project (Pixel 7) from `playwright.projects.cjs`, and
`PDMUX_WEBKIT=1` adds `ui-mobile-webkit` (iPhone 14).

## Workers and exclusive tests

The suite runs on one worker unless `E2E_WORKERS` says otherwise. For the whole
suite, more workers finish sooner:

```bash
E2E_WORKERS=2 bun run test:e2e
```

Set the count with `E2E_WORKERS`, not `--workers`: the global setup refuses more
than one worker when `E2E_WORKERS` is unset.

Every test shares one API, database, mail catcher, and SMS sink. A test that
changes state other tests rely on takes the `@exclusive` tag:

```ts
test("maintenance mode holds visitors back", { tag: "@exclusive" }, async ({ page }) => {
  // ...
});
```

Tag a test when it changes a server-wide setting (a feature flag, the
authentication configuration such as SMTP, social providers, or sign-up
approval, the site settings, or a module's settings) or the profile of a seeded
account. Each project has an `<name>-exclusive` twin, such as `ui-exclusive`,
that runs only the tagged tests, one at a time. Never empty the shared mail
catcher or SMS sink in a test: send to an address or number of the test's own
instead.

The `test:e2e` scripts run `run-e2e.ts`, which hands its arguments (a file,
`--grep`, `--project`) to Playwright. With more than one worker it runs
Playwright twice: first every test not tagged `@exclusive` on those workers,
then the tagged tests on one worker, even when a test failed in the first run.
The suite fails when either run fails. The second run reports to
`playwright-report/exclusive` and `test-results/exclusive`:

```bash
bunx playwright show-report playwright-report/exclusive
```

A plain `bunx playwright test` with `E2E_WORKERS` above 1 makes one run in which
the twins depend on every other test: a failing test there leaves the exclusive
tests not run, and selecting an exclusive test runs every other test first. Use
`bun run test:e2e` on more workers, and do not combine `--no-deps` with
`E2E_WORKERS` above 1.

Application-owned projects in `playwright.projects.cjs` get twins too. A project
that another project depends on is a setup project and keeps a single copy.

## pdmux accounts, one per worker

The pdmux specs that drive the fleet import `test` and `expect` from
`helpers/pdmux-test.ts` instead of `@playwright/test`. They run as accounts of
their own, never as the seeded `admin@example.com`:

- `pdmux-e2e@example.com` (`E2E_OWNER` in `helpers/pdmux-accounts.ts`) owns the
  `pdmux e2e` organization, whose fleet holds the live host `pdmux-e2e-host` and
  eleven offline filler hosts. `pdmux-e2e-host.setup.ts` signs it up in the
  `setup` project and writes the host's agent token to
  `playwright/.auth/pdmux-e2e-agent-token.txt`. List the address in
  `ADMIN_EMAILS` before the account signs up: it creates the worker accounts,
  and only an administrator changes an organization's fleet. Setup stops and
  says so otherwise.
- Each Playwright worker signs in as `pdmux-e2e-w<N>@example.com`, where `<N>`
  is the worker's `parallelIndex`. On a worker's first test, the `e2eState`
  fixture creates the account as an administrator, adds it to the organization,
  gives it an empty saved layout, and saves its session in
  `playwright/.auth/pdmux-e2e-w<N>.json`. The worker accounts are created after
  the setup's user baseline, so the `cleanup` project removes them when the run
  ends and the next run creates them again. A `--no-deps` run reuses them. With
  `E2E_WORKERS` above 1, `bun run test:e2e` makes two Playwright runs and each
  has its own `setup` and `cleanup`: the first run creates and removes one
  account per worker, and the exclusive run, on one worker, creates
  `pdmux-e2e-w0` again.
- Both take their password from `E2E_SUITE_ADMIN_PASSWORD`. Without it they use
  the suite default, which is right only on a stack the suite created.

Pages and the `request` fixture get the worker's session by default. A context
or request context a spec opens itself passes `storageState: e2eState`, in hooks
too. `test.use({ storageState: userState })` still runs a block as the seeded
user.

The dashboard layout, the sidebar, and card preferences belong to the worker's
account, so workers never see each other's. The fleet belongs to the
organization, which every worker shares:

- Give each host, file, and storage key a test creates a unique name, and delete
  only what the test created.
- Type only into terminal sessions named by `workerSession()`, such as
  `pdmux-e2e-w0`. Two workers in one session type into the same shell.
- Tag a test `@exclusive` when it writes the organization's fleet settings, such
  as the host retention, or its integrations.

The terminal, git, and file specs need an agent connected to `pdmux-e2e-host`
with that token, and skip without one. Each run's setup mints one more token for
the host and revokes none, so an agent started with the first run's token stays
connected through the exclusive run. To run the whole suite on two workers
against the containerized loop, with the exclusive tests' report in
`playwright-report/exclusive`:

```bash
E2E_BASE_URL=http://pdmux.localhost E2E_WORKERS=2 bun run test:e2e
```

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
that runs only the tagged tests, one at a time. With more than one worker the
twins wait for every other test, so an exclusive test never runs alongside
another one. Never empty the shared mail catcher or SMS sink in a test: send to
an address or number of the test's own instead.

More than one worker suits the whole suite. When a run selects exclusive tests
with a file name, `--grep`, or `--project`, Playwright also runs every other test
first, because the twins depend on them, and a test that fails there marks the
exclusive tests as not run. Use the default single worker for a few files, and
do not combine `--no-deps` with `E2E_WORKERS` above 1.

Application-owned projects in `playwright.projects.cjs` get twins too. A project
that another project depends on is a setup project and keeps a single copy.

# Folder transfers

The file explorer transfers folder trees, including empty directories, with a shared web/desktop
controller. The destination is captured at upload start; navigating to another directory or host
does not redirect it. The remote boundary remains the agent account's home directory.

Browser runtime imports use `@pdmux/protocol/transfer-limits`, a schema-free entry point sharing
the server's constants. Agent validation remains in the canonical protocol schemas. The production
smoke test imports the emitted transfer controller as well as the terminal relay before serving a route.

## Using the explorer

- **Upload folder** includes the selected directory itself. You can also drop files and folders
  together onto the explorer. Ordinary file selection still works.
- A folder or multiple-item download becomes one **ZIP64 archive**. A single file keeps its
  original format and uses the existing streaming download endpoint.
- Enable **Select files and folders** (the check-mark toolbar button), select the desired folders
  and files, then press Download. Disable selection mode to open folders with a click again.
- Existing directories merge. Files prompt for **Overwrite**, **Skip**, or **Cancel transfer**,
  optionally for all subsequent conflicts. Files cannot replace directories or vice versa.
  Skipping a conflicting directory skips its children too.
- **Transfers** shows scanning, fingerprint calculation, acknowledged upload bytes, ZIP preparation,
  item counts, and the current path. Collapse the panel without stopping work; pause/resume/cancel
  are separate controls.

Web folder picking requires a secure context and `showDirectoryPicker` support. Otherwise use
folder drag-and-drop where the browser exposes directory entries. The app does not use a file-only
directory picker that silently loses empty folders. Electron handles native folder selection.
Native and agent scanners exclude symbolic links and special files and require review before
continuing. Browser selection is limited to entries its APIs expose; it cannot independently inspect
native link metadata.

## Pause, restart, and integrity

Uploads use at most **1 MiB** binary requests. Progress advances after the agent acknowledges
durable bytes, not when the browser merely sends them. Each chunk has a SHA-256 digest. A source
fingerprint is SHA-256 of the concatenated lowercase hexadecimal chunk hashes; an empty file uses
SHA-256 of the empty string. The agent rechecks the staged file before publication.

After a reload or application restart, open Transfers, choose **Resume**, and reselect the original
folder/files. Drop the same mixed selection onto the reselect dialog. Paths, sizes and fingerprints
must match before resuming. For changed content, start a new transfer. The browser does not persist
permission to read arbitrary local paths.

The agent keeps ownership journals in `.pdmux-file-transfers` and sibling staging files named
`.pdmux-transfer-<job>-<entry>.part`. The original destination remains intact until the verified
replacement is published. Publication is atomic **per file**, not across the whole tree. Cancel and
expiry remove staging data, not files or directories already published. Permissions/timestamps are
not copied: new files are private (`0600`), new directories `0700`.

The API pauses interrupted jobs after restart. An upload with no active request for 90 seconds is
paused so another job can use the host. Jobs are queued per host. A partially prepared ZIP is rebuilt
on resume; a ready ZIP is immutable with a stable SHA-256 ETag.

**Save ZIP** hands the archive to the browser download manager. The preparation percentage does
not mean it has been saved to your disk. Browser progress/resume depend on the browser; the endpoint
supports `Range` and `If-Range` without rebuilding. Desktop saves persist partial-download offsets,
revalidate the authenticated job/ETag, and reconstruct interrupted Electron downloads after restart.
Before normal application shutdown, desktop preserves the unfinished file beside the selected output
as `.part.resume`, using a hard link or a native copy when hard links are unavailable. This happens
before closing the window, because Chromium removes its own incomplete download on exit. Startup
restores the preserved bytes; completion, cancellation, and expiry clean up the sidecar. On filesystems
without hard links, shutdown may require additional free space for the copy.
Desktop reports completion only after archive verification and publication to the selected output.

Partial ZIP responses use an explicitly bounded file stream. This preserves the requested byte
interval when API middleware merges response headers; the regression test compares actual HTTP
bytes, including through the production web proxy. See [runtime verification](READINESS.md).

Temporary transfer data expires after **24 hours without activity**. API cleanup runs every minute;
the agent cleans owned staging files at startup and hourly, including when disconnected. Ready ZIPs
and partial downloads are temporary, not backups. Cancel/expiry never deletes a saved output file.

## Limits and deployment

| Setting | Default | Scope |
|---|---:|---|
| `FILE_TRANSFER_DIR` | `data/file-transfers` | Private spool, relative to the API working directory |
| `FILE_TRANSFER_MAX_BYTES` | `10737418240` (10 GiB) | Source bytes per job; may be lowered |
| `FILE_TRANSFER_MAX_ENTRIES` | `10000` | Visited entries/exclusions per job; may be lowered |
| `FILE_TRANSFER_SPOOL_BYTES` | `21474836480` (20 GiB) | Combined ready/in-progress ZIP reservations |

Up to 250 top-level download selections and 32 active jobs per user/host are accepted. Agent pages
contain at most 250 entries and never silently truncate a large transfer tree. ZIP **store mode**
bounds CPU use but does not reduce payload size. Reservation includes headers, plus a 64 MiB free
disk margin. Paths must be relative, without traversal, backslashes, NULs, colons, or staging names.

The spool must be writable by the API user and never exposed by a static-file server. Run one API
replica with its agent registry. Persist the spool across API replacement:

- The API image sets `FILE_TRANSFER_DIR=/data/file-transfers`, owned by `bun`. Self-host Compose
  mounts a named volume there.
- The k3s example includes `file-transfers-pvc.yaml`, an API mount and filesystem group. Apply the
  claim before the API Deployment; adjust capacity/storage class for the host.
- `podo deploy` renders its own resources and does not read these illustrative manifests. Add an
  equivalent private, persistent API volume to the actual deployment profile.
- Embedded desktop uses `runtime/file-transfers` in application data. Native records live in
  `file-transfers/downloads.json`; partial files live beside the chosen output.

The web adapter/reverse proxy must allow a 1 MiB binary body (supplied web configurations use
`BODY_SIZE_LIMIT=3M`). Web proxy and API independently enforce the chunk cap. Never buffer a whole
folder/archive in the renderer or proxy.

Long agent operations override Bun's request idle timeout without changing the server-wide default.
Chunk body intake still has a 60-second idle bound; agent acknowledgements have their own deadlines
(30 seconds normally, 5 minutes for final verification). Configure any external proxy's response
timeout to accommodate that verification period.

## Upgrade compatibility

Deploy the new API/web and run `migrate:all` **before updating agents**. PostgreSQL uses the statically
registered `AddFileTransfers1731700000000` migration, adding two independent tables without changing
existing data. Desktop SQLite adds the entities through its existing schema synchronization path.
Back up the database before upgrading.

Folder transfers require **`files-transfer-v1`**, introduced in agent **0.1.25**. Older agents retain legacy single-file behavior and
receive an upgrade notice for folders. The new API accepts old agents; an older API's closed
capability enum cannot accept a new agent hello. Product/agent versions remain governed by
[`VERSIONING.md`](VERSIONING.md).

## HTTP and agent boundaries

Every endpoint requires a dashboard session and validates user, organization, enabled host and
capability. Other users' jobs are inaccessible, even within the same organization. MCP credentials
do not gain access. Audit records contain operation metadata, never file bytes or local source paths.

Endpoints below are relative to `/hosts/:hostId/file-transfers` (the browser adds `/api`):

| Method / suffix | Purpose |
|---|---|
| `GET /`, `POST /` | List/create with UUID, direction, base path and selection |
| `GET /:id`, `GET /:id/entries` | Read progress and manifest |
| `POST /:id/manifest` | Idempotent batch of up to 250 upload entries |
| `POST /:id/control` | `start`, `pause`, or `cancel` |
| `POST /:id/entries/:entryId/reconcile` | Agent's durable offset/commit state |
| `POST /:id/entries/:entryId/decision` | `replace` or `skip` after a conflict |
| `PUT /:id/entries/:entryId/chunk` | Binary body, `X-Transfer-Offset` and `X-Transfer-Sha256` |
| `POST /:id/entries/:entryId/commit` | Verify/publish a file or create a directory |
| `GET /:id/download` | ZIP: `200`, single-range `206`, invalid-range `416` |

`fsTransfer` / `fsTransferResult` carry request, job and entry IDs. Actions are `list`, `stat`,
`mkdir`, `read`, `write`, `commit`, `discard`, and `touch`. Failures use stable `FILES_TRANSFER_*`
codes, including `SOURCE_CHANGED`, `CONFLICT`, `TYPE_CONFLICT`, `EXCLUDED`, `DISK_FULL`, `LIMIT`,
`TIMEOUT`, and `RESTARTED` with that prefix. The UI localizes codes instead of exposing OS errors.

## Isolated verification

These tests do not use deployment credentials or mutate a live installation:

```bash
bun run --cwd packages/protocol test
bun run --cwd apps/api test
bun run --cwd apps/web test
bun run --cwd apps/desktop test
(cd agent && go test ./... && go vet ./...)
(cd apps/web && bunx playwright test --config test/file-transfers-ui/playwright.config.ts)
bun run test:migrations
```

Playwright renders the real explorer/controller in an isolated Vite harness with mock HTTP. It
checks delayed chunks, conflict controls, empty folders, reload/resume and measured responsive
geometry. For actual Go filesystem + API service + SQLite tests, build the bounded protocol bridge:

```bash
transfer_tools=$(mktemp -d)
(cd agent && go build -o "$transfer_tools/bridge" ./internal/fs/testdata/bridge)
(cd apps/api && PDMUX_TRANSFER_TEST_AGENT="$transfer_tools/bridge" \
  bun test integration/file-transfer-agent.spec.ts --timeout 600000)
# Optional: requires more than 9 GiB free temporary disk space.
(cd apps/api && PDMUX_TRANSFER_TEST_AGENT="$transfer_tools/bridge" PDMUX_TRANSFER_LARGE_TEST=1 \
  bun test integration/file-transfer-agent.spec.ts --timeout 600000)
```

Tests create/remove their own temporary directories. The large case validates a ZIP beyond 4 GiB
with `unzip`, checks suffix ranges, and samples API memory. The bridge exercises real Go operations
and generated wire validation over stdin/stdout, not a deployed WebSocket. macOS/Windows dialogs and
download restart still require native acceptance checks before release. Linux packaged-app restart,
authenticated range resumption, and final hash verification run separately through
[`smoke-desktop-downloads.mjs`](../tools/smoke-desktop-downloads.mjs), as described in
[desktop verification](DESKTOP.md#desktop-development).

For actual HTTP routes, WebSocket gateway/registry/ingest and the full Go daemon together,
run the runtime spec on Linux with a local Docker engine and `unzip`:

```bash
transfer_runtime=$(mktemp -d)
(cd agent && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -o "$transfer_runtime/agent" ./cmd/pdmux-agent)
(cd apps/api && PDMUX_TRANSFER_RUNTIME_AGENT="$transfer_runtime/agent" \
  bun test integration/file-transfer-runtime.spec.ts)
```

This creates a disposable unprivileged container/user and SQLite database. It checks a real
agent hello/heartbeat, overwrite conflict, durable byte progress, daemon/service restart,
offset reconciliation, empty directories, archive payload hashes, Range and cancellation cleanup.
The test removes its container, image tag and temporary data. Session authentication, host metadata,
audit and metric storage are fixture dependencies; this is not a full login/deployment test or a
packaged desktop test. The UI harness above independently exercises the browser/controller path.

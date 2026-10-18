# Audit log

An append-only trail of **who did what, to which resource, when** — the
actor / action / target model. Every entry flows through one pipeline
(`AuditService` → the `audit_logs` table) so they all share one shape.

## What gets recorded

Nothing is recorded automatically except the built-in **auth/admin actions**
(login, user create/update/delete, ban, role change, session revoke, ...),
which the Better Auth plugin in `audit-hook.ts` maps to semantic action codes like
`user.create` and `auth.login`. Everything else is **opt-in** — you decide what
matters.

The plugin records an action only when the request succeeded, so a wrong
password or a forbidden admin call leaves no entry. Every sign-in method records
`auth.login` with the method in `metadata.method` (`password`, `email-otp`,
`magic-link`, `passkey`, `two-factor-totp`, ...) and, for social sign-in, the
provider in `metadata.provider`. A two-factor sign-in is recorded when the second
factor completes it, not at the password step. `auth.ts` pushes the plugin after
every other plugin: Better Auth runs after hooks in plugin order, and two-factor
changes the outcome of a password sign-in in its own after hook.

## Audit your own Elysia routes

```ts
const session = await auth.requireSession(request);
const todo = await todos.create(body);
await audit.recordRequest("todo.create", request, session, {
  type: "todo",
  id: todo.id,
  label: todo.title,
});
return todo;
```

Call `recordRequest` only after the operation succeeds. It attaches the actor and
request address, then writes the target metadata through the shared pipeline.

## Record from anywhere in code

```ts
import { recordAudit } from "../audit/audit-events";

await recordAudit({
  action: "invoice.paid",
  actorId, actorName, actorEmail,
  targetType: "invoice", targetId: invoice.id, targetLabel: invoice.number,
  metadata: { amount },
});
```

Resolve `AUDIT` from the application service registry to call
`audit.record({ ... })`. Audit writes never break the request, and every write
path checks the admin on/off toggle.

## Deferred recording

`recordAudit()` and `recordRequest()` await the INSERT, so the response waits for
the write. For high-volume events that are not security relevant (comments,
content edits, views), queue the entry instead:

```ts
import { recordAuditLater } from "../audit/audit-events";

recordAuditLater({ action: "comment.create", actorId, targetType: "comment", targetId: comment.id });

// or, in a route
await audit.recordRequest("comment.create", request, session, { type: "comment", id: comment.id }, { defer: true });
```

Queued entries are written with one multi-row INSERT every 250 ms, as soon as
100 are waiting, and when the API shuts down cleanly. **Entries still queued
when the process crashes or is killed are lost.** The queue holds at most 1,000
entries; past that, new deferred entries are dropped with a warning, and an
`audit.dropped` entry (`metadata.count`) records the gap once a write succeeds.

Keep `auth.*`, `user.*`, and other security events on the awaited path. The
Better Auth hook always awaits.

## Retention

Entries are kept forever unless `AUDIT_LOG_RETENTION_DAYS` is set to a whole
number of days. Then, on startup and about every hour, the API deletes older
entries in batches of 1,000 rows and records an `audit.pruned` entry with the
count and cutoff. Leave it unset or `0` unless a written retention policy
requires deletion: many compliance regimes require a minimum retention period,
and pruned entries cannot be recovered.

## Fields (`AuditEntry`)

`action` (semantic code), `actorId/actorName/actorEmail` (denormalized so the log
survives renames/deletes), `targetType/targetId/targetLabel`, `ip`, `metadata`
(jsonb, free-form), `createdAt`.

## Customize

- **Auth actions:** `ACTIONS` in `audit-hook.ts` maps Better Auth endpoints to
  action codes, and `SIGN_IN_METHODS` lists the endpoints that sign a user in.
  The `audit-hook.spec.ts` test fails when the app's Better Auth gains a sign-in
  endpoint that neither list classifies.
- **Your routes:** call `AuditService.recordRequest()` after successful operations;
  pass `{ defer: true }` only for high-volume, non-security events.
- **Schema:** add columns with a migration, and keep the
  `AuditEntry` type in `audit-events.ts` in sync. A new list filter needs an
  index that starts with its column and ends with `"createdAt"`, like those in
  `1792000000000-IndexAuditLogFilters.ts`.
- **Reading:** `GET /audit-logs` (admin only) returns a page as an array, newest
  first, filtered by exact `action`, `actor` (email), and `target` (label). Pass
  the `X-Next-Cursor` response header back as `cursor` for the next page; `limit`
  is 1 to 100 (default 50) and `order=asc` reverses the order.
  `GET /audit-logs/actions` lists the recorded action codes. Routes live in
  `audit.routes.ts`.

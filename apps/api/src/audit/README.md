# Audit log

An append-only trail of **who did what, to which resource, when** — the
actor / action / target model. Every entry flows through one pipeline
(`AuditService` → the `audit_logs` table) so they all share one shape.

## What gets recorded

Nothing is recorded automatically except the built-in **auth/admin actions**
(login, user create/update/delete, ban, role change, session revoke, ...),
which the better-auth hook (`audit-hook.ts`) maps to semantic action codes like
`user.create` and `auth.login`. Everything else is **opt-in** — you decide what
matters.

## Audit your own routes with `@Audit`

```ts
import { Audit } from "../audit/audit.decorator";

@Post()
@Audit("todo.create", (_req, todo) => ({ type: "todo", id: todo.id, label: todo.title }))
create(@Body() dto: CreateTodoDto) {
  return this.todos.create(dto);
}
```

The interceptor resolves the acting user (name + email), attaches the target you
return, and writes one entry when the handler succeeds.

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

Or inject `AuditService` in a Nest provider and call `audit.record({ ... })`.
Both never throw — a failed audit write never breaks the request.

## Fields (`AuditEntry`)

`action` (semantic code), `actorId/actorName/actorEmail` (denormalized so the log
survives renames/deletes), `targetType/targetId/targetLabel`, `ip`, `metadata`
(jsonb, free-form), `createdAt`.

## Customize

- **Auth actions:** edit the `ACTIONS` map in `audit-hook.ts`.
- **Your routes:** add `@Audit("your.action")` where you want a trail.
- **Schema:** add columns to `audit-log.entity.ts` + a migration, and keep the
  `AuditEntry` type in `audit-events.ts` in sync.
- **Reading:** `GET /audit-logs` returns the latest 50 (admin only); extend
  `audit.controller.ts` for filtering/pagination.

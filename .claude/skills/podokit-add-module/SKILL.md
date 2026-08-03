---
name: podokit-add-module
description: Use when the user wants a feature that a PodoKit module already provides (authentication, an admin dashboard, Redis, background jobs/queues, object storage, file uploads, SSE, rate limiting, logging). Prefer adding the module over hand-writing it.
---

# Add a PodoKit module

Before building auth, an admin panel, queues, storage, etc. by hand, check
whether a module provides it — modules wire themselves into the app correctly.

```bash
podo add                 # list available modules
podo add <module>        # e.g. auth, admin-dashboard, redis, bullmq, file-upload
npm install              # install newly-added dependencies
```

Common modules: `auth` (better-auth: email/password, sessions, OAuth, 2FA,
secure-by-default), `admin-dashboard` (user/session/org management + audit +
runtime settings, requires auth), `redis`, `bullmq` (queue + worker),
`job-progress` (SSE progress), `object-storage-s3`, `file-upload`, `sse`,
`rate-limit`, `logging`, `api-key-auth`.

Notes:
- A module auto-adds its required modules (e.g. `admin-dashboard` adds `auth`).
- After adding, follow the printed next steps (often DB migrations, e.g.
  `npx @better-auth/cli migrate -y --config apps/api/src/auth/auth.ts`).
- Module wiring lands inside `// podokit:` fenced regions — don't hand-edit those.

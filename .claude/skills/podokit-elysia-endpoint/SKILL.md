---
name: podokit-elysia-endpoint
description: Use when adding or changing an Elysia REST endpoint in apps/api. Covers typed validation, access policy, the standard error envelope, OpenAPI, and Bun tests.
---

# Add an Elysia endpoint

1. Create or extend an `Elysia` plugin under `apps/api/src/<feature>/`. Export a
   module descriptor with `plugin`, optional startup `configure`, and optional
   OpenAPI contribution. Wire it in `apps/api/src/app.ts` inside the
   `// podokit:begin:imports` and `// podokit:begin:modules` fences.
2. Validate path, query, headers, and bodies with Elysia `t` schemas. Keep
   TypeScript strict, avoid `any`, and declare function return types.
   Use the same parameter name at the same structural route position throughout
   one application: `/hosts/:hostId` and `/hosts/:hostId/files` are compatible,
   while `/hosts/:id` and `/hosts/:hostId/files` are not.
3. Throw `AppException("STABLE_CODE", "message", statusCode)` for domain
   failures. The global handler renders
   `{ success: false, error: { code, message, statusCode, path, timestamp } }`.
4. APIs are authenticated by default when auth is installed. Register an
   explicit `public`, `session`, `admin`, or `api-key` policy for every route.
   A `GET` policy also covers `HEAD`, which Elysia answers with the GET handler.
5. Add route detail and response schemas so the endpoint is present in the
   merged OpenAPI document at `/api-docs-json`.
   Browsers reach the endpoint through the web `/api` proxy, which drops
   headers it does not know. When the endpoint reads a custom request header or
   returns one the browser needs, add its name to the app-owned
   `apps/web/src/lib/server/proxy-headers.ts`.
6. Add a `bun:test` unit or integration test beside the feature. Verify with
   `bun run lint`, `bun test`, `bun run build`, and
   `bun run --cwd apps/api contract` without starting a dev server. The contract
   gate assembles every plugin and rejects conflicting route parameter names.

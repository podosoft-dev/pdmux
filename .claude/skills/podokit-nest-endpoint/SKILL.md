---
name: podokit-nest-endpoint
description: Use when adding or changing a NestJS REST endpoint in apps/api — a controller/service with DTO validation, the standard error envelope, and a test. Follow this for any new backend route in a PodoKit project.
---

# Add a NestJS endpoint (PodoKit conventions)

1. **Module**: create/extend a Nest module under `apps/api/src/<feature>/`
   (`<feature>.module.ts`, `.controller.ts`, `.service.ts`, `dto/`). Register the
   module in `apps/api/src/app.module.ts` — add it **inside** the
   `// podokit:begin:module-imports … end` fence, never outside it.
2. **DTOs**: validate every input with `class-validator` decorators on a DTO
   class. No `any`; give explicit return types.
3. **Errors**: throw `AppException("STABLE_CODE", "message", statusCode)` (from
   `@podosoft/podokit-contracts` / the app's `common/`). The global filter renders
   it as `{ success: false, error: { code, message, statusCode, path, timestamp } }`.
   Pick a stable, UPPER_SNAKE `code` — the frontend branches on it.
4. **Auth**: if the `auth` module is installed the API is secure by default; mark
   public routes with `@Public()` and read the user with `@Session()`.
5. **Swagger**: annotate with `@ApiTags` so it shows under `/api-docs`.
6. **Test**: add an e2e/unit test under `apps/api` or the `tests/` workspace
   (Nest e2e or Vitest + supertest). Verify with
   `npm run build -w pdmux-api` and the test.

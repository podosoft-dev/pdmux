---
name: podokit-sveltekit-route
description: Use when adding or changing a SvelteKit page/route in apps/web — pages that call the API, use shadcn-svelte components, and localize text. Follow this for any new frontend screen in a PodoKit project.
---

# Add a SvelteKit route (PodoKit conventions)

1. **Route**: add a folder under `apps/web/src/routes/`. Load data in
   `+page.server.ts` / `+layout.server.ts` (SSR), not in the browser.
2. **Call the API only through the server proxy** — never a direct browser
   `fetch` to `:5002`. Use the app's `ApiClient`: `#lib/api.js` (browser,
   same-origin `/api/*` proxy) and `#lib/server/api.js` (SSR, internal URL +
   cookie forwarding). It throws `ApiError` — branch on `err.code`.
3. **Svelte 5 runes only**: `$state`, `$derived`, `$effect`, `$props`. Never `$:`.
4. **UI**: use shadcn-svelte components (`#lib/components/ui/*/index.js`) over raw HTML.
   Do **not** edit `ui/**` — wrap it if you need to customize. Semantic Tailwind
   classes (`bg-background`, `text-foreground`); responsive (`sm:`/`md:`/`lg:`).
   For any list/table, use the shared `DataTable` (see the podokit-data-table
   skill, added with the admin-dashboard module).
5. **i18n**: no hardcoded user-facing strings — add keys to
   `apps/web/src/lib/i18n/messages.ts` for **every** locale.
6. **Verify**: `bun run --cwd apps/web build` (includes `svelte-check`)
   and add/adjust a Playwright test in `tests/`.

---
name: podokit-add-locale
description: Add, translate, validate, activate, or troubleshoot a JSON locale in a PodoKit-generated SvelteKit app. Use when a user asks to add a language, split or edit locale JSON, check translation coverage or placeholders, configure fallback behavior, or verify locale changes through Vite HMR.
---

# PodoKit Add Locale

Add languages through the PodoKit locale commands and the app-owned JSON catalog. Keep module catalogs managed so `podo update` can continue to update them.

## Workflow

1. Inspect the existing locale state.

   ```sh
   podo locale list
   ```

2. Add a canonical BCP 47 language tag. Set `--direction rtl` only for right-to-left languages.

   ```sh
   podo locale add pt-BR --name "Português (Brasil)"
   ```

3. Read [references/catalog-format.md](references/catalog-format.md), then translate the new app-owned file at `apps/web/src/lib/i18n/catalogs/app/<locale>.json`.

4. Validate key coverage, JSON value types, and interpolation placeholders.

   ```sh
   podo locale validate pt-BR
   ```

5. Activate the locale. Partial catalogs are permitted because runtime fallback fills missing keys, but report the coverage percentage to the user.

   ```sh
   podo locale activate pt-BR
   ```

6. Run the app with its documented container-based development command. Verify the language switch, one complete key, one fallback key, and locale persistence. Editing an existing JSON file must update through Vite HMR without restarting the container. Adding a new locale file may trigger an automatic full-page reload.

## Rules

- Treat `en` as the stable final fallback and never deactivate it.
- Preserve placeholders exactly. For example, translate `Hello {name}` without renaming or removing `{name}`.
- Put product-specific copy only in `catalogs/app/`. Do not edit `catalogs/admin-dashboard/` or other module catalogs directly.
- Keep locale definition filenames identical to their canonical codes, including case such as `pt-BR.json`.
- Do not activate a locale definition before its JSON parses and `podo locale validate` succeeds.
- Do not use the UI message catalogs for user-authored records. Dynamic content needs locale-aware records and a separate publication/fallback policy.
- When deactivating a locale, preserve its files so it can be reactivated without losing translations.

## Fallback And Site Default

The message runtime resolves missing keys in this order: selected locale, configured site default, then English. The site default is an administrator choice, not a build-time constant. Changing it must not delete or rewrite catalogs.

If a requested language is unsupported or inactive, resolve it to the configured site default. Keep localized URL and SEO behavior in the consuming app; the catalogs provide translated strings but do not define routing policy.

## Completion Checklist

- `podo locale validate` succeeds for every active locale.
- The new locale definition is active and has the intended display name and direction.
- App-owned JSON contains the new product copy; managed module catalogs remain untouched.
- Development edits update without a container restart.
- Automated tests cover selection, fallback, placeholders, and at least one incomplete catalog.
- User-facing locale setup or routing documentation is updated when behavior changes.

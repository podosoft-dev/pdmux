# JSON Catalog Format

## Directory Layout

```text
apps/web/src/lib/i18n/
├── locales/
│   ├── en.json
│   ├── ko.json
│   └── pt-BR.json
└── catalogs/
    ├── admin-dashboard/  # PodoKit-managed module messages
    ├── blog/             # module-managed messages when installed
    └── app/              # app-owned product messages and overrides
```

Each locale definition has this shape:

```json
{
  "code": "pt-BR",
  "name": "Português (Brasil)",
  "direction": "ltr",
  "enabled": false
}
```

`code` must be a canonical BCP 47 tag and must match the filename. `direction` is `ltr` or `rtl`. Newly added locales stay inactive until explicitly activated.

## Catalog Composition

Catalogs are nested JSON objects with strings at their leaves:

```json
{
  "common": {
    "save": "Save",
    "welcome": "Welcome, {name}"
  }
}
```

The runtime lazily loads every `catalogs/*/<locale>.json` file. Module catalogs are merged first in stable name order; the `app` catalog is merged last, so the consuming app may intentionally override module copy without modifying managed files.

English defines the complete key and value-type contract. Other locales may omit keys, but translated values must retain the English type and all `{placeholder}` names. JSON objects and arrays are supported; executable expressions are not.

## Development Reloading

Catalog imports use Vite's `import.meta.glob`. Changes to an existing JSON dependency participate in Vite HMR and must appear without restarting the development container. A new file changes the glob membership and may cause Vite to reload the page automatically. If neither occurs, confirm that the app source directory, including `apps/web/src`, is mounted or synced by the development compose configuration.

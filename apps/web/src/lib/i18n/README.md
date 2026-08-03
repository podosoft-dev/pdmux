# Localization

Locale definitions live in `locales/<code>.json`. Product copy and intentional
module overrides live in the app-owned `catalogs/app/<code>.json` files.

The admin-dashboard module installs the composed JSON message runtime and its
complete English and Korean catalogs. Use `podo locale add`, `validate`, and
`activate` to extend it. See the generated `$podokit-add-locale` skill for the
complete workflow.

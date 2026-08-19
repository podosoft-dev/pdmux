# Third-party notices

pdmux is licensed under Apache-2.0 (see `LICENSE`). The material listed here is
**not** covered by that licence and keeps its own terms. Nothing below is a
sub-licence: it is the attribution those terms require, kept in one place so a
reader does not have to infer it from a directory listing.

## vscode-icons — file-type icons (CC BY-SA 4.0)

| | |
|---|---|
| Where | `packages/ui/src/icons/vscode-icons/` (and the copy of it inside `@pdmux/ui`'s published `dist/`) |
| Upstream | https://github.com/vscode-icons/vscode-icons — tag v12.19.0 |
| Licence | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Credit | © vscode-icons contributors |

Upstream splits its own licensing in three: *"The source code is licensed under
the MIT license. The icons are licensed under the Creative Commons - ShareAlike
(CC BY-SA) license. Branded icons are licensed under their copyright license."*
Only icons are used here — no upstream source code.

⚠ **The SVG files are redistributed unchanged, and that is a condition rather
than a convenience.** An edited icon would be Adapted Material, and CC BY-SA's
ShareAlike term would then reach what it was combined with. So they are not
recoloured, re-pathed, minified or merged, and `packages/ui/src/icons/vscode-icons/SOURCE.md`
carries a sha256 per file so the claim is checkable. The stylesheet says the same
thing where somebody would otherwise reach for `fill`.

⚠ **Some of them are trademarks** — the marks of the languages and tools whose
file types they identify (Python, Rust, Docker, npm, and others). They are used
for that identification only. No endorsement or affiliation is claimed or
implied, and each mark remains its owner's property under its owner's terms.

## lucide — icon path data (ISC)

Individual paths are copied inline into components in `packages/ui/src/components/`
rather than imported, so that package keeps a single peer dependency. Each site
names the icon it came from. lucide is ISC, © Lucide Icons and Contributors —
https://github.com/lucide-icons/lucide.

`apps/web` uses the package itself (`@lucide/svelte`) in the ordinary way.

## Runtime dependencies

Everything installed from npm keeps the licence declared in its own package. This
file covers only material that was **copied into this repository**, where a
`node_modules` entry would not exist to declare it.

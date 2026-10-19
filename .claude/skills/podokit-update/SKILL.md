---
name: podokit-update
description: Use when the user wants to update a Bun-based project to a newer PodoKit v1 version, pull in template/module improvements, check local edits, or take ownership of a managed file. Covers podo status/diff/doctor/update/eject/restore.
---

# Keep a PodoKit project up to date

The project records how it was assembled in `.podokit/` so the toolkit can update
its own files while keeping the user's changes.

```bash
podo status          # version, modules, file tiers, and how many managed files were edited
podo diff            # list the PodoKit-managed files you've edited (owned files ignored)
podo diff <path>     # line diff of one file against the template (owned files too)
podo doctor          # check framework versions vs. the supported ranges
podo update          # dry-run: preview what a newer version would change (writes nothing)
podo update --apply  # apply it — clean updates are written; edits the template also changed are 3-way merged
podo eject <path>    # take ownership of a managed file so update skips it
podo restore <path>  # rewrite a managed file from the template; re-manages an ejected file
```

Rules to respect:
- **owned** files (routes, your components, `AGENTS.md`, shadcn `ui/**`) are never
  touched by `update`. When their template changes, the plan lists them as
  `review`; compare with `podo diff <path>` and copy what the app needs.
- **assembled** files are recomputed from the module set — keep edits **outside**
  the `// podokit:begin…end` fences.
- Run `podo update` (dry-run) first and read the plan before `--apply`. Commit or
  stash your work beforehand so a merge is easy to review.
- In the plan, `keep` is an edited file whose template did not change (or that the
  new version drops): `--apply` leaves it as it is. `merge` is an edited file whose
  template changed too: `--apply` 3-way merges it and reports merged or conflict.
  The preview runs those merges against the same base and shows the ones that
  would conflict as `conflict`. When it prints `WARN the N merge(s) were not
  checked` (it could not get the previous version's templates from npm), pass
  them with `podo update --from <previous templates>`.
- In a fresh clone or git worktree, run `bun install` before `podo update` when the
  project uses an external module package (`.podokit/manifest.json` records its
  `packageName`); PodoKit reads that module from `node_modules`.
- PodoKit v1 projects are Bun-only. A PodoKit 0.x project must keep using its
  pinned 0.x CLI; there is no in-place NestJS/Node conversion path.

---
name: podokit-update
description: Use when the user wants to update the project to a newer PodoKit version, pull in template/module improvements, check what they've changed vs the generated code, or take ownership of a managed file. Covers podo status/diff/doctor/update/eject.
---

# Keep a PodoKit project up to date

The project records how it was assembled in `.podokit/` so the toolkit can update
its own files while keeping the user's changes.

```bash
podo status          # version, modules, file tiers, and how many managed files were edited
podo diff            # list the PodoKit-managed files you've edited (owned files ignored)
podo doctor          # check framework versions vs. the supported ranges
podo update          # dry-run: preview what a newer version would change (writes nothing)
podo update --apply  # apply it — clean updates are written; your edits are 3-way merged
podo eject <path>    # take ownership of a managed file so update skips it
```

Rules to respect:
- **owned** files (routes, your components, `AGENTS.md`, shadcn `ui/**`) are never
  touched by `update`.
- **assembled** files are recomputed from the module set — keep edits **outside**
  the `// podokit:begin…end` fences.
- Run `podo update` (dry-run) first and read the plan before `--apply`. Commit or
  stash your work beforehand so a merge is easy to review.

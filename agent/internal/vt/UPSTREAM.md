# Upstream of this package

This directory is a copy of `github.com/charmbracelet/x/vt` at commit
`67fa755d101a` (pseudo-version `v0.0.0-20261012121731-67fa755d101a`), MIT
licensed — see `LICENSE` in this directory, which stays with the code.

It was copied rather than imported because native sessions need state the
library keeps private: which rows continue the row above (a soft wrap), and a
resize that rewraps lines instead of cutting them. Upstream had neither at that
commit.

## What pdmux changed

The list below is the whole difference from upstream. To take a newer upstream,
copy it over this directory and apply these changes again.

(filled in by the commits that make the changes)

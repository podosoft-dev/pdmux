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

- `lineinfo.go` (new): `LineInfo` (soft wrap, wide-character filler, width),
  per-row flags on `Screen`, `Emulator.LineInfo`, `Emulator.ScrollbackLineInfo`,
  and the rule that erasing a whole row ends the logical line there.
- `reflow.go` (new): `Screen.reflow`, `Emulator.LogicalLines`, the joining of
  soft-wrapped rows, and row tracking for readers of the history.
- `emulator.go`: `Resize` rewraps the main screen (also while the alternate
  screen is shown) instead of cutting rows and dropping the bottom ones;
  `ResizeTracking` added. The alternate screen is cut or padded as before.
- `screen.go`: `flags` beside the buffer; `Reset`/`Resize`/`ClearArea`/
  `FillArea`/`ClearWithScrollback`/`InsertLine`/`DeleteLine` keep them true
  (`shiftFlags`); lines pushed by a scroll carry their flags.
- `scrollback.go`: `info` beside `lines`, `Info`, `Pushed` (a counter that keeps
  growing when the buffer is full), `replace`; trimming keeps the placeholder
  of a trailing wide character.
- `utf8.go`: soft wraps are recorded (`softWrap`); a wide character that does
  not fit wraps whole and leaves filler, and one that ends in the last column
  leaves the cursor pending a wrap instead of being overwritten.
- `cc.go`: an explicit line feed into an existing row starts a new logical line.
- `handlers.go`: ED 1 also ends the soft wrap of the row below, as in xterm.
- `reflow_test.go` (new): the tests for all of the above.

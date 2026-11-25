package vt

import uv "github.com/charmbracelet/ultraviolet"

// LineInfo describes one screen row or one scrollback line. It is what lets a
// reader put soft-wrapped rows back together into the line the program wrote,
// and what lets a resize rewrap lines instead of cutting them.
//
// pdmux addition: upstream keeps no record of soft wraps.
type LineInfo struct {
	// Wrapped is true when this row continues the logical line of the row
	// before it: the previous row filled up and the output wrapped onto this
	// one (xterm calls this isWrapped).
	Wrapped bool
	// Pad is true when the row's last cell is filler left by a wide character
	// that did not fit in it and wrapped to the next row. The filler is not
	// part of the text.
	Pad bool
	// Width is the screen width the row was written at. A scrollback line has
	// its trailing blank cells trimmed, so a wrapped row's trailing spaces are
	// restored from this.
	Width int
}

// rowFlags is the per-row part of LineInfo kept beside the screen buffer.
type rowFlags struct {
	wrapped, pad bool
}

// syncFlags keeps one entry per buffer row.
func (s *Screen) syncFlags() {
	h := s.buf.Height()
	if len(s.flags) != h {
		s.flags = make([]rowFlags, h)
	}
}

func (s *Screen) flagsAt(y int) rowFlags {
	if y < 0 || y >= len(s.flags) {
		return rowFlags{}
	}
	return s.flags[y]
}

func (s *Screen) setWrapped(y int, wrapped bool) {
	if y >= 0 && y < len(s.flags) {
		s.flags[y].wrapped = wrapped
	}
}

func (s *Screen) setPad(y int, pad bool) {
	if y >= 0 && y < len(s.flags) {
		s.flags[y].pad = pad
	}
}

func (s *Screen) clearFlags(from, to int) {
	for y := max(0, from); y < min(to, len(s.flags)); y++ {
		s.flags[y] = rowFlags{}
	}
}

// erased updates the flags after the cells of area were erased or filled, as
// xterm does: a row erased in full no longer continues the row above, and
// erasing up to the last column removes a wide-character filler. The row
// after an erased row keeps its flag (a program erasing a row to redraw it
// has not ended the line below); ED 1 clears it itself.
func (s *Screen) erased(area uv.Rectangle) {
	w := s.buf.Width()
	area = area.Intersect(s.buf.Bounds())
	for y := area.Min.Y; y < area.Max.Y; y++ {
		if area.Max.X >= w {
			s.setPad(y, false)
		}
		if area.Min.X <= 0 && area.Max.X >= w {
			s.setWrapped(y, false)
		}
	}
}

// LineInfo returns what is known about row y of the active screen.
func (e *Emulator) LineInfo(y int) LineInfo {
	f := e.scr.flagsAt(y)
	return LineInfo{Wrapped: f.wrapped, Pad: f.pad, Width: e.scr.Width()}
}

// ScrollbackLineInfo returns what is known about scrollback line index of the
// main screen (0 is the oldest).
func (e *Emulator) ScrollbackLineInfo(index int) LineInfo {
	return e.Scrollback().Info(index)
}

// isBlank reports whether c is an unstyled blank: what trimming removes.
func isBlank(c *uv.Cell) bool {
	return c.IsZero() || c.Equal(&uv.EmptyCell)
}

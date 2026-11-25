package vt

import (
	"slices"
	"sort"

	uv "github.com/charmbracelet/ultraviolet"
)

// pdmux addition: rewrap the main screen and its scrollback on resize.
//
// Upstream cut every row to the new width and dropped the bottom rows when the
// screen got shorter, so narrowing a window lost the text past the new edge
// for good, and widening it again neither brought the text back nor joined
// the wrapped rows. A reflow puts soft-wrapped rows back together into the
// lines the program wrote (LineInfo.Wrapped), wraps those at the new width,
// and keeps the newest rows on screen: what tmux and xterm do.

// reflowRow is one row of the rewrapped output.
type reflowRow struct {
	cells []uv.Cell
	flags rowFlags
}

// trimmedLen is the length of cells without trailing unstyled blanks. The
// placeholder after a wide character is part of that character, not a blank.
func trimmedLen(cells []uv.Cell) int {
	n := len(cells)
	for n > 0 && isBlank(&cells[n-1]) {
		if cells[n-1].IsZero() && n >= 2 && cells[n-2].Width > 1 {
			break
		}
		n--
	}
	return n
}

// wellFormed reports whether every wide character in cells is followed by its
// placeholders and no placeholder stands alone: a line that can be used as a
// row without rebuilding it.
func wellFormed(cells []uv.Cell) bool {
	for i := 0; i < len(cells); {
		c := &cells[i]
		if c.IsZero() {
			return false
		}
		w := max(1, c.Width)
		for j := 1; j < w; j++ {
			if i+j >= len(cells) || !cells[i+j].IsZero() {
				return false
			}
		}
		i += w
	}
	return true
}

func rowBlank(line uv.Line) bool {
	return trimmedLen(line) == 0
}

// position is a place in a logical line: which line, and how many cells in.
type position struct{ line, off int }

// lastRow is the last screen row that matters: the cursor's, or a later row
// with text or a soft wrap. Blank rows below it are not text.
func (s *Screen) lastRow() int {
	last, h := s.cur.Y, s.buf.Height()
	for y := h - 1; y > last; y-- {
		if s.flags[y].wrapped || (y+1 < h && s.flags[y+1].wrapped) || !rowBlank(s.buf.Line(y)) {
			return y
		}
	}
	return last
}

// logical joins the scrollback sb and the screen rows up to lastRow into the
// lines the program wrote, and says where in them each old row began (one
// position per scrollback line, then per screen row). A row the next row
// continues is taken at full width: spaces the scrollback trimmed come back
// and a wide-character filler cell is dropped. The last row of a line loses
// its trailing blanks.
func (s *Screen) logical(sb *Scrollback) ([][]uv.Cell, []position, int) {
	s.syncFlags()
	scrollbackLen, width := len(sb.lines), s.buf.Width()
	last := s.lastRow()
	total := scrollbackLen + last + 1
	wrappedAt := func(g int) bool {
		if g == 0 {
			return false
		}
		if g < scrollbackLen {
			return sb.info[g].Wrapped
		}
		return s.flags[g-scrollbackLen].wrapped
	}
	rowCells := func(g int, continued bool) []uv.Cell {
		var cells []uv.Cell
		var info LineInfo
		if g < scrollbackLen {
			cells, info = sb.lines[g], sb.info[g]
		} else {
			y := g - scrollbackLen
			f := s.flags[y]
			cells, info = s.buf.Line(y), LineInfo{Wrapped: f.wrapped, Pad: f.pad, Width: width}
		}
		if !continued {
			return cells[:trimmedLen(cells)]
		}
		w := max(info.Width, len(cells))
		full := make([]uv.Cell, w)
		copy(full, cells)
		for i := len(cells); i < w; i++ {
			full[i] = uv.EmptyCell
		}
		if info.Pad && w > 0 && isBlank(&full[w-1]) {
			full = full[:w-1]
		}
		return full
	}
	positions := make([]position, total)
	var lines [][]uv.Cell
	for g := range total {
		continued := g+1 < total && wrappedAt(g+1)
		if !wrappedAt(g) {
			if !continued {
				// A line of one row is used as it is, without a copy. The
				// capacity is cut so appending to it can never write into the
				// row it came from.
				cells := rowCells(g, false)
				lines = append(lines, cells[:len(cells):len(cells)])
				positions[g] = position{len(lines) - 1, 0}
				continue
			}
			lines = append(lines, nil)
		}
		l := len(lines) - 1
		positions[g] = position{l, len(lines[l])}
		lines[l] = append(lines[l], rowCells(g, continued)...)
	}
	return lines, positions, last
}

// LogicalLines returns the main screen's scrollback and screen joined into the
// lines the program wrote: soft-wrapped rows put back together, wide-character
// filler dropped, trailing blanks trimmed. Blank rows below the cursor and the
// last text are left out. The cells are copies.
//
// pdmux addition.
func (e *Emulator) LogicalLines() []uv.Line {
	main := &e.scrs[0]
	sb := main.scrollback
	if sb == nil {
		sb = &Scrollback{}
	}
	lines, _, _ := main.logical(sb)
	out := make([]uv.Line, len(lines))
	for i, line := range lines {
		out[i] = slices.Clone(line[:trimmedLen(line)])
	}
	return out
}

// reflow resizes the screen to width x height and rewraps it together with its
// scrollback. phantom says the cursor is pending a wrap (it only matters for
// the active screen), awm whether autowrap is on. track lists positions in the
// combined history (index i < scrollback length is scrollback line i, and
// scrollback length + y is screen row y); the result says where each of them
// went. The second result is whether the cursor is left pending a wrap.
func (s *Screen) reflow(width, height int, phantom, awm bool, track []int) ([]int, bool) {
	oldW, oldH := s.buf.Width(), s.buf.Height()
	if width == oldW && height == oldH {
		return slices.Clone(track), phantom
	}
	s.syncFlags()
	sb := s.scrollback
	if sb == nil {
		sb = NewScrollback(DefaultScrollbackSize)
		sb.maxLines = 0 // nothing is kept, but the rows still rewrap
	}
	scrollbackLen := len(sb.lines)
	lines, positions, last := s.logical(sb)
	topAnchored := last < oldH-1
	total := scrollbackLen + last + 1

	// The cursor's place in its line. A cursor past the end of the text (after
	// a prompt's trailing space, or spaces just typed) keeps its distance.
	cursor := positions[scrollbackLen+s.cur.Y]
	cursor.off += s.cur.X
	if phantom {
		cursor.off++
	}
	for len(lines[cursor.line]) < cursor.off {
		lines[cursor.line] = append(lines[cursor.line], uv.EmptyCell)
	}
	saved, savedBelow := position{}, -1
	if s.saved.Y <= last {
		saved = positions[scrollbackLen+s.saved.Y]
		saved.off = min(saved.off+s.saved.X, len(lines[saved.line]))
	} else {
		savedBelow = s.saved.Y - last
	}
	oldTop := positions[scrollbackLen]

	// Wrap every line at the new width. A wide character never splits: if it
	// does not fit, the rest of the row is filler and it starts the next row.
	var out []reflowRow
	lineStart := make([]int, len(lines))
	var rowOff []int // offset in its line where each output row starts
	for l, line := range lines {
		lineStart[l] = len(out)
		if len(line) <= width && wellFormed(line) {
			// Fits as it is: one row, shared rather than copied.
			out = append(out, reflowRow{cells: line})
			rowOff = append(rowOff, 0)
			continue
		}
		var row []uv.Cell
		start, wrapped := 0, false
		flush := func(pad bool, next int) {
			out = append(out, reflowRow{cells: row, flags: rowFlags{wrapped: wrapped, pad: pad}})
			rowOff = append(rowOff, start)
			row, start, wrapped = nil, next, true
		}
		for i := 0; i < len(line); {
			c := line[i]
			glyph, used := []uv.Cell{c}, 1
			switch {
			case c.IsZero():
				// A placeholder without its wide character.
				glyph = []uv.Cell{uv.EmptyCell}
			case c.Width > 1:
				for used < c.Width && i+used < len(line) && line[i+used].IsZero() {
					used++
				}
				glyph = make([]uv.Cell, c.Width)
				glyph[0] = c
			}
			if len(glyph) > width {
				// Wider than the whole screen: nothing can show it.
				glyph = []uv.Cell{uv.EmptyCell}
			}
			if len(row)+len(glyph) > width {
				pad := len(row) < width
				for len(row) < width {
					row = append(row, uv.EmptyCell)
				}
				flush(pad, i)
			}
			row = append(row, glyph...)
			i += used
		}
		flush(false, 0)
	}
	at := func(p position) (int, int) {
		first, end := lineStart[p.line], len(out)
		if p.line+1 < len(lineStart) {
			end = lineStart[p.line+1]
		}
		r := first + sort.Search(end-first, func(i int) bool { return rowOff[first+i] > p.off }) - 1
		r = max(r, first)
		return r, p.off - rowOff[r]
	}

	// Which rows are the screen. A screen anchored at the top keeps its first
	// row unless the text no longer fits below it; a full screen shows the
	// newest rows. Either way the cursor stays on screen.
	n := len(out)
	cursorRow, cursorCol := at(cursor)
	top := max(0, n-height)
	if topAnchored {
		oldTopRow, _ := at(oldTop)
		top = max(oldTopRow, n-height)
	}
	top = max(0, min(top, cursorRow))

	// Rows above the screen are the scrollback, trimmed as Push trims them.
	keep := make([]uv.Line, 0, top)
	info := make([]LineInfo, 0, top)
	for _, r := range out[:top] {
		// Output rows are either new or shared with rows nothing writes to
		// any more (old scrollback lines, the old screen), so they are kept
		// without another copy.
		n := trimmedLen(r.cells)
		keep = append(keep, r.cells[:n:n])
		info = append(info, LineInfo{Wrapped: r.flags.wrapped, Pad: r.flags.pad, Width: width})
	}
	dropped := max(0, len(keep)-sb.maxLines)
	sb.replace(keep, info)

	buf := uv.NewRenderBuffer(width, height)
	flags := make([]rowFlags, height)
	for y := range height {
		if r := top + y; r < n {
			copy(buf.Lines[y], out[r].cells)
			flags[y] = out[r].flags
		}
	}
	if dropped > 0 && top == dropped {
		// The row it continued was dropped with the oldest scrollback.
		flags[0].wrapped = false
	}
	buf.Touched = nil
	s.buf, s.flags = buf, flags
	s.scroll = s.buf.Bounds()

	pending := false
	if cursorCol >= width {
		cursorCol, pending = width-1, awm
	}
	s.cur.X, s.cur.Y = cursorCol, cursorRow-top
	if savedBelow < 0 {
		r, c := at(saved)
		s.saved.X, s.saved.Y = min(c, width-1), r-top
	} else {
		s.saved.Y = n - 1 - top + savedBelow
	}
	s.saved.X = max(0, min(s.saved.X, width-1))
	s.saved.Y = max(0, min(s.saved.Y, height-1))

	moved := make([]int, len(track))
	for i, g := range track {
		var r int
		switch {
		case g < 0:
			r = 0
		case g < total:
			r, _ = at(positions[g])
		default:
			r = n - 1 + g - (total - 1)
		}
		moved[i] = max(0, r-dropped)
	}
	return moved, pending
}

package session

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/podosoft-dev/pdmux/agent/internal/vt"
)

func renderCells(cells []uv.Cell) string {
	var b strings.Builder
	style := ""
	for i := range cells {
		cell := &cells[i]
		if cell.Content == "" && cell.Width == 0 {
			continue
		}
		current := cell.Style.String()
		if style != current {
			b.WriteString("\x1b[0m")
			b.WriteString(current)
			style = current
		}
		if cell.Link.URL != "" {
			b.WriteString(cell.Link.String())
		}
		if cell.Content == "" {
			b.WriteByte(' ')
		} else {
			b.WriteString(cell.Content)
		}
		if cell.Link.URL != "" {
			b.WriteString("\x1b]8;;\x1b\\")
		}
	}
	b.WriteString("\x1b[0m")
	return b.String()
}

// trimBlank drops trailing unstyled blank cells. The frame erases a row before
// drawing it, so they draw nothing; printed, they became trailing spaces in
// everything copied from the viewer's terminal.
func trimBlank(cells []uv.Cell) []uv.Cell {
	n := len(cells)
	for n > 0 && (cells[n-1].IsZero() || cells[n-1].Equal(&uv.EmptyCell)) {
		n--
	}
	return cells[:n]
}

func renderRow(terminal *vt.Emulator, x, y, width int) string {
	return renderCells(rowCells(terminal, x, y, width))
}

// rowCells is the part of screen row y a viewport from column x, width wide,
// shows, without half a wide glyph at either edge.
func rowCells(terminal *vt.Emulator, x, y, width int) []uv.Cell {
	cells := make([]uv.Cell, 0, width)
	for col := x; col < min(terminal.Width(), x+width); col++ {
		cell := terminal.CellAt(col, y)
		if cell == nil {
			cells = append(cells, uv.EmptyCell)
			continue
		}
		// A viewport must not paint half a wide glyph at either edge.
		if cell.Content == "" && cell.Width == 0 {
			if col == x {
				cells = append(cells, uv.EmptyCell)
			}
			continue
		}
		if col+max(1, cell.Width) > x+width {
			cells = append(cells, uv.EmptyCell)
			continue
		}
		cells = append(cells, *cell)
	}
	return cells
}

// joinedRow renders a row that continues the row above it (a soft wrap) so
// that the terminal drawing it records the wrap too, the way xterm.js marks
// IBufferLine.isWrapped: copying, word selection and link detection then treat
// the two rows as one line, as they would for a program writing straight into
// that terminal. The frame has already moved to this row (1-based y+1) and
// erased it. This goes back to the last glyph of the row above (row y),
// prints it again with autowrap on, then this row's first glyph, which wraps
// onto this row and marks it, and the rest with autowrap off again.
//
// Autowrap is on for two glyphs only, and the wrap leaves the row above, never
// the bottom row, so the terminal cannot scroll. If the two terminals measured
// a glyph differently only this row is affected. It returns false when the
// rows do not have the shape a soft wrap leaves, and the row is drawn plainly.
func joinedRow(above []uv.Cell, aboveInfo vt.LineInfo, below []uv.Cell, width, y int) (string, bool) {
	if aboveInfo.Width != width || len(above) > width {
		return "", false
	}
	full := make([]uv.Cell, width)
	copy(full, above)
	for i := len(above); i < width; i++ {
		full[i] = uv.EmptyCell
	}
	// The anchor ends in the last column, or one before it when a wide glyph
	// did not fit and left filler there.
	end := width
	if aboveInfo.Pad {
		end--
	}
	a := end - 1
	if a >= 0 && full[a].IsZero() {
		a--
	}
	if a < 0 || full[a].IsZero() || a+max(1, full[a].Width) != end {
		return "", false
	}
	first := []uv.Cell{uv.EmptyCell}
	var rest []uv.Cell
	if len(below) > 0 {
		if below[0].IsZero() {
			return "", false
		}
		n := min(len(below), max(1, below[0].Width))
		first, rest = below[:n], below[n:]
	}
	if aboveInfo.Pad && first[0].Width < 2 {
		// Only a wide glyph wraps out of the one column the filler holds.
		return "", false
	}
	return fmt.Sprintf("\x1b[%d;%dH\x1b[?7h", y, a+1) + renderCells(full[a:end]) + renderCells(first) + "\x1b[?7l" + renderCells(trimBlank(rest)), true
}

// Input-related modes only. Application escape sequences, queries and OSC side
// effects never reach a viewer through this renderer.
func inputModes(s *running, v *View) string {
	keys := []int{1, 9, 66, 1000, 1002, 1003, 1004, 1006, 1015, 2004}
	var b strings.Builder
	// xterm has one mouse tracker. Resetting an inactive tracker after enabling
	// the active one disables reporting too, so resets must precede all enables.
	for _, number := range keys {
		b.WriteString(ansi.ResetMode(ansi.DECMode(number)))
	}
	for _, number := range keys {
		if s.modes[ansi.DECMode(number)] && (v.history == 0 || number == 2004) {
			b.WriteString(ansi.SetMode(ansi.DECMode(number)))
		}
	}
	return b.String()
}

func (e *Engine) render(s *running, v *View, full bool) {
	// Output does not invalidate a reader's frozen snapshot. Do not replace an
	// unread full snapshot with a cursor-only diff or clear a selection because
	// the normal screen is busy behind it.
	if v.history > 0 && v.historyRows != nil && !full {
		return
	}
	if len(v.frames) > 0 {
		select {
		case <-v.frames:
			full = true
		default:
		}
	}
	if v.follow && v.history == 0 {
		cursor := s.vt.CursorPosition()
		if cursor.X < v.x {
			v.x = cursor.X
		}
		if cursor.X >= v.x+v.cols {
			v.x = cursor.X - v.cols + 1
		}
		if cursor.Y < v.y {
			v.y = cursor.Y
		}
		if cursor.Y >= v.y+v.rows {
			v.y = cursor.Y - v.rows + 1
		}
	}
	v.x = max(0, min(max(0, s.cols-v.cols), v.x))
	v.y = max(0, min(max(0, s.rows-v.rows), v.y))
	rows := make([]string, v.rows)
	history := s.vt.Scrollback()
	length := s.vt.ScrollbackLen()
	// Each view row's cells and where it comes from: a scrollback line or a
	// screen row, numbered together (scrollback first), or -1 for nothing.
	cells := make([][]uv.Cell, v.rows)
	sources := make([]int, v.rows)
	for y := range rows {
		sources[y] = -1
		line := v.y + y
		if v.history > 0 {
			index := length - v.history + y
			if index < length {
				if row := history.Line(index); len(row) > v.x {
					cells[y], sources[y] = row[v.x:min(len(row), v.x+v.cols)], index
				}
				continue
			}
			line = index - length
		}
		if line < s.rows {
			cells[y], sources[y] = rowCells(s.vt, v.x, line, v.cols), length+line
		}
	}
	info := func(source int) vt.LineInfo {
		if source < length {
			return s.vt.ScrollbackLineInfo(source)
		}
		return s.vt.LineInfo(source - length)
	}
	// Soft wraps are drawn as wraps only where the view shows whole rows of
	// the main screen. A narrower or panned view cuts rows, and a full-screen
	// program on the alternate screen positions everything itself.
	joins := !s.vt.IsAltScreen() && v.x == 0 && v.cols == s.cols
	for y := range rows {
		if sources[y] < 0 {
			continue
		}
		if joins && y > 0 && sources[y-1] >= 0 && sources[y] == sources[y-1]+1 && info(sources[y]).Wrapped {
			if row, ok := joinedRow(cells[y-1], info(sources[y-1]), cells[y], v.cols, y); ok {
				rows[y] = row
				continue
			}
		}
		rows[y] = renderCells(trimBlank(cells[y]))
	}
	// A reading/selection viewport is frozen until its owner scrolls, resizes,
	// follows or types. New output must not move the text under a selection.
	if v.history > 0 {
		if v.historyRows == nil {
			v.historyRows = rows
		} else {
			rows = v.historyRows
		}
	}
	var b strings.Builder
	if full || len(v.last) != len(rows) {
		b.WriteString("\x1b[?1049h\x1b[?7l\x1b[0m\x1b[2J")
		full = true
	}
	modes := inputModes(s, v)
	if full || modes != v.lastModes {
		b.WriteString(modes)
	}
	for y, row := range rows {
		if full || row != v.last[y] {
			fmt.Fprintf(&b, "\x1b[%d;1H\x1b[0m\x1b[2K%s", y+1, row)
		}
	}
	cursor := s.vt.CursorPosition()
	style, blink := s.vt.CursorStyle()
	cursorStyle := int(style)*2 + 1
	if !blink {
		cursorStyle++
	}
	b.WriteString(ansi.SetCursorStyle(cursorStyle))
	if s.vt.CursorHidden() || v.history > 0 || cursor.X < v.x || cursor.X >= v.x+v.cols || cursor.Y < v.y || cursor.Y >= v.y+v.rows {
		b.WriteString("\x1b[?25l")
	} else {
		fmt.Fprintf(&b, "\x1b[%d;%dH\x1b[?25h", cursor.Y-v.y+1, cursor.X-v.x+1)
	}
	if b.Len() > MaxScreenBytes {
		v.offer(Reply{Type: "error", Error: "SESSION_SCREEN_LIMIT"})
		return
	}
	s.sequence++
	v.last = rows
	v.lastModes = modes
	v.offer(Reply{Type: "screen", Screen: &Screen{Data: b.String(), Sequence: s.sequence, Cols: v.cols, Rows: v.rows, CanvasCols: s.cols, CanvasRows: s.rows, X: v.x, Y: v.y, Follow: v.follow, Alternate: s.vt.IsAltScreen(), History: v.history}})
}

func trimHistory(terminal *vt.Emulator) {
	history := terminal.Scrollback()
	if history == nil {
		return
	}
	bytes, keep := 0, 0
	lines := history.Lines()
	for index := len(lines) - 1; index >= 0; index-- {
		cost := 0
		for _, cell := range lines[index] {
			cost += len(cell.Content) + len(cell.Link.URL) + len(cell.Link.Params) + 160
		}
		if bytes+cost > HistoryBytes {
			break
		}
		bytes += cost
		keep++
	}
	if keep < len(lines) {
		history.SetMaxLines(max(1, keep))
		history.SetMaxLines(HistoryLines)
	}
}

var sgrMouse = regexp.MustCompile(`\x1b\[<([0-9]+);([0-9]+);([0-9]+)[Mm]`)

// Typing reports whether input from a viewer is something a person typed: wheel,
// mouse and focus reports are not. The viewer that types is the one in use.
func Typing(data, source string) bool {
	return source != "wheel" && !mouseOnly(data) && data != "\x1b[I" && data != "\x1b[O"
}

func mouseOnly(data string) bool {
	if data == "" {
		return false
	}
	return sgrMouse.ReplaceAllString(data, "") == "" || strings.HasPrefix(data, "\x1b[M") && len([]rune(data[3:])) == 3
}

// Translate SGR and legacy UTF-8 mouse coordinates from the viewport to the PTY.
// SGR is the mode advertised to new applications by xterm-compatible clients.
func translateMouse(data string, x, y int) string {
	if x == 0 && y == 0 {
		return data
	}
	// Paste bytes are text, even when they happen to look like mouse reports.
	if strings.Contains(data, "\x1b[200~") {
		return data
	}
	if sgrMouse.MatchString(data) {
		return sgrMouse.ReplaceAllStringFunc(data, func(report string) string {
			parts := strings.Split(report[3:len(report)-1], ";")
			col, ce := strconv.Atoi(parts[1])
			row, re := strconv.Atoi(parts[2])
			if ce != nil || re != nil {
				return report
			}
			return fmt.Sprintf("\x1b[<%s;%d;%d%s", parts[0], col+x, row+y, report[len(report)-1:])
		})
	}
	if strings.HasPrefix(data, "\x1b[M") {
		coordinates := []rune(data[3:])
		if len(coordinates) == 3 {
			coordinates[1] += rune(x)
			coordinates[2] += rune(y)
			return "\x1b[M" + string(coordinates)
		}
	}
	return data
}

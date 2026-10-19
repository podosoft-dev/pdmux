package session

import (
	"fmt"
	"strconv"
	"strings"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
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

func renderRow(terminal *vt.Emulator, x, y, width int) string {
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
	return renderCells(cells)
}

// Input-related modes only. Application escape sequences, queries and OSC side
// effects never reach a viewer through this renderer.
func inputModes(s *running) string {
	keys := []int{1, 9, 66, 1000, 1002, 1003, 1004, 1006, 1015, 2004}
	var b strings.Builder
	for _, number := range keys {
		if s.modes[ansi.DECMode(number)] {
			b.WriteString(ansi.SetMode(ansi.DECMode(number)))
		} else {
			b.WriteString(ansi.ResetMode(ansi.DECMode(number)))
		}
	}
	return b.String()
}

func (e *Engine) render(s *running, v *View, full bool) {
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
	for y := range rows {
		line := v.y + y
		if v.history > 0 {
			index := s.vt.ScrollbackLen() - v.history + y
			if index < s.vt.ScrollbackLen() {
				cells := history.Line(index)
				if len(cells) > v.x {
					rows[y] = renderCells(cells[v.x:min(len(cells), v.x+v.cols)])
				}
				continue
			}
			line = index - s.vt.ScrollbackLen()
		}
		if line < s.rows {
			rows[y] = renderRow(s.vt, v.x, line, v.cols)
		}
	}
	var b strings.Builder
	if full || len(v.last) != len(rows) {
		b.WriteString("\x1b[?1049h\x1b[?7l\x1b[0m\x1b[2J")
		full = true
	}
	modes := inputModes(s)
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
	v.offer(Reply{Type: "screen", Screen: &Screen{Data: b.String(), Sequence: s.sequence, Cols: v.cols, Rows: v.rows, CanvasCols: s.cols, CanvasRows: s.rows, X: v.x, Y: v.y, Follow: v.follow}})
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

// Translate SGR and legacy UTF-8 mouse coordinates from the viewport to the PTY.
// SGR is the mode advertised to new applications by xterm-compatible clients.
func translateMouse(data string, x, y int) string {
	if x == 0 && y == 0 {
		return data
	}
	if strings.HasPrefix(data, "\x1b[<") && (strings.HasSuffix(data, "M") || strings.HasSuffix(data, "m")) {
		parts := strings.Split(data[3:len(data)-1], ";")
		if len(parts) == 3 {
			col, ce := strconv.Atoi(parts[1])
			row, re := strconv.Atoi(parts[2])
			if ce == nil && re == nil {
				return fmt.Sprintf("\x1b[<%s;%d;%d%s", parts[0], col+x, row+y, data[len(data)-1:])
			}
		}
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

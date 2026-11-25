package vt

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"

	uv "github.com/charmbracelet/ultraviolet"
)

// pdmux tests for soft-wrap tracking and resize reflow. Named TestNativeVT so
// the native-terminal workflow runs them on every platform.

func newVT(w, h int) *Emulator {
	e := NewEmulator(w, h)
	e.SetScrollbackSize(5000)
	return e
}

func feed(e *Emulator, s string) { _, _ = e.Write([]byte(s)) }

func lineText(cells []uv.Cell) string {
	var b strings.Builder
	for i := range cells {
		if cells[i].IsZero() {
			continue
		}
		b.WriteString(cells[i].Content)
	}
	return strings.TrimRight(b.String(), " ")
}

func logicalText(e *Emulator) []string {
	var out []string
	for _, line := range e.LogicalLines() {
		out = append(out, lineText(line))
	}
	return out
}

func screenRows(e *Emulator) []string {
	rows := make([]string, e.Height())
	for y := range rows {
		rows[y] = lineText(e.scr.buf.Line(y))
	}
	return rows
}

// invariants holds after every operation: one flag entry per row and one info
// entry per scrollback line on both screens, and the cursor on screen.
func invariants(t *testing.T, e *Emulator) {
	t.Helper()
	for i := range e.scrs {
		s := &e.scrs[i]
		if len(s.flags) != s.buf.Height() {
			t.Fatalf("screen %d: %d flags for %d rows", i, len(s.flags), s.buf.Height())
		}
		if sb := s.scrollback; sb != nil && len(sb.info) != len(sb.lines) {
			t.Fatalf("screen %d: %d infos for %d scrollback lines", i, len(sb.info), len(sb.lines))
		}
		for _, line := range s.buf.Lines {
			if len(line) != s.buf.Width() {
				t.Fatalf("screen %d: row of %d cells on a %d-wide screen", i, len(line), s.buf.Width())
			}
		}
	}
	x, y := e.scr.CursorPosition()
	if x < 0 || x >= e.Width() || y < 0 || y >= e.Height() {
		t.Fatalf("cursor %d,%d outside %dx%d", x, y, e.Width(), e.Height())
	}
}

func digits(n int) string {
	var b strings.Builder
	for i := range n {
		b.WriteByte(byte('0' + i%10))
	}
	return b.String()
}

func TestNativeVTSoftWrap(t *testing.T) {
	long := "A" + digits(70) + "Z"
	t.Run("[TC-PDTERM-181] a row filled by wrapping output continues the row above", func(t *testing.T) {
		e := newVT(40, 5)
		feed(e, long)
		if e.LineInfo(0).Wrapped || !e.LineInfo(1).Wrapped {
			t.Fatalf("flags %v %v", e.LineInfo(0), e.LineInfo(1))
		}
		if got := logicalText(e); len(got) != 1 || got[0] != long {
			t.Fatalf("logical lines %q", got)
		}
		invariants(t, e)
	})
	t.Run("[TC-PDTERM-181] an explicit line break does not, even after a full row", func(t *testing.T) {
		e := newVT(40, 5)
		feed(e, digits(40)+"\r\nx")
		if e.LineInfo(1).Wrapped {
			t.Fatal("CRLF after a full row marked a wrap")
		}
		feed(e, "\r\n"+digits(40)+"y")
		if !e.LineInfo(3).Wrapped {
			t.Fatal("a 41st character did not wrap")
		}
	})
	t.Run("[TC-PDTERM-181] line feed, erase, insert and delete keep the flags truthful", func(t *testing.T) {
		e := newVT(40, 5)
		feed(e, long+"\x1b[1;1H\n")
		if e.LineInfo(1).Wrapped {
			t.Fatal("a line feed into the continued row kept its flag")
		}
		e = newVT(40, 5)
		feed(e, long+"\x1b[1;1H\x1b[2K")
		if e.LineInfo(1).Wrapped {
			t.Fatal("erasing the row above kept the continuation")
		}
		e = newVT(40, 5)
		feed(e, long+"\x1b[1;1H\x1b[L")
		if e.LineInfo(1).Wrapped || !e.LineInfo(2).Wrapped {
			t.Fatalf("insert line: %v %v", e.LineInfo(1), e.LineInfo(2))
		}
		e = newVT(40, 5)
		feed(e, "x\r\n"+long+"\x1b[2;1H\x1b[M")
		if e.LineInfo(1).Wrapped {
			t.Fatal("delete line left the row continuing a deleted row")
		}
		invariants(t, e)
	})
	t.Run("[TC-PDTERM-181] a line half scrolled off still joins its scrollback part", func(t *testing.T) {
		// 120 characters are three rows on a two-row screen: the first went to
		// the scrollback.
		longer := digits(120)
		e := newVT(40, 2)
		feed(e, "one\r\n"+longer)
		if !e.LineInfo(0).Wrapped {
			t.Fatalf("screen row 0 should continue the scrollback: %q", screenRows(e))
		}
		got := logicalText(e)
		if len(got) != 2 || got[0] != "one" || got[1] != longer {
			t.Fatalf("logical lines %q", got)
		}
		invariants(t, e)
	})
	t.Run("[TC-PDTERM-181] a trailing space at the wrap point survives the scrollback", func(t *testing.T) {
		e := newVT(10, 2)
		feed(e, "abcdefghi jkl\r\n\r\n\r\n")
		if got := logicalText(e); got[0] != "abcdefghi jkl" {
			t.Fatalf("logical lines %q", got)
		}
	})
}

func TestNativeVTWideCharacters(t *testing.T) {
	t.Run("[TC-PDTERM-181] a wide character that does not fit wraps whole", func(t *testing.T) {
		e := newVT(10, 3)
		feed(e, "abcdefghi가")
		if !e.LineInfo(0).Pad || !e.LineInfo(1).Wrapped {
			t.Fatalf("flags %v %v", e.LineInfo(0), e.LineInfo(1))
		}
		if c := e.CellAt(0, 1); c == nil || c.Content != "가" {
			t.Fatalf("row 1 starts with %v", c)
		}
		if got := logicalText(e); got[0] != "abcdefghi가" {
			t.Fatalf("logical lines %q (filler must not become a space)", got)
		}
	})
	t.Run("[TC-PDTERM-181] a wide character ending in the last column is not overwritten", func(t *testing.T) {
		e := newVT(10, 3)
		feed(e, "abcdefgh가x")
		if c := e.CellAt(8, 0); c == nil || c.Content != "가" {
			t.Fatalf("column 8 holds %v", c)
		}
		if c := e.CellAt(0, 1); c == nil || c.Content != "x" || !e.LineInfo(1).Wrapped {
			t.Fatalf("x went to %v, wrapped=%v", c, e.LineInfo(1).Wrapped)
		}
	})
	t.Run("[TC-PDTERM-181] a screen narrower than a wide character does not loop", func(t *testing.T) {
		e := newVT(1, 3)
		feed(e, "가나다")
		invariants(t, e)
	})
	t.Run("[TC-PDTERM-182] Korean text rewraps without loss", func(t *testing.T) {
		text := "가나다라마바사아자차카타파하"
		e := newVT(10, 6)
		feed(e, text)
		for _, w := range []int{7, 15, 3, 10, 29} {
			e.Resize(w, 6)
			invariants(t, e)
			if got := logicalText(e); got[0] != text {
				t.Fatalf("width %d: %q", w, got)
			}
		}
	})
}

func TestNativeVTReflow(t *testing.T) {
	long := "A" + digits(70) + "Z"
	t.Run("[TC-PDTERM-182] narrowing and widening rewraps the same text", func(t *testing.T) {
		e := newVT(40, 8)
		feed(e, "\x1b[31mred\x1b[0m "+long+"\r\n$ ")
		want := logicalText(e)
		for _, step := range []struct{ w, rows int }{{20, 4}, {80, 1}, {40, 2}} {
			e.Resize(step.w, 8)
			invariants(t, e)
			if got := logicalText(e); strings.Join(got, "|") != strings.Join(want, "|") {
				t.Fatalf("width %d: %q, want %q", step.w, got, want)
			}
			rows := 0
			for _, row := range screenRows(e) {
				if strings.Contains(row, "0") || strings.Contains(row, "Z") {
					rows++
				}
			}
			if rows != step.rows {
				t.Fatalf("width %d: the long line takes %d rows, want %d: %q", step.w, rows, step.rows, screenRows(e))
			}
		}
		if fg := e.LogicalLines()[0][0].Style.Fg; fg == nil {
			t.Fatal("the colour of the first word was lost")
		}
	})
	t.Run("[TC-PDTERM-182] dragging the width one column at a time loses nothing", func(t *testing.T) {
		e := newVT(80, 10)
		feed(e, "first "+long+"\r\n가나다라마바사 "+long+"\r\nshort\r\n"+long+long+"\r\n$ ")
		want := strings.Join(logicalText(e), "|")
		for w := 79; w >= 12; w-- {
			e.Resize(w, 10)
			invariants(t, e)
			if got := strings.Join(logicalText(e), "|"); got != want {
				t.Fatalf("width %d: %q", w, got)
			}
		}
		for w := 13; w <= 80; w++ {
			e.Resize(w, 10)
			if got := strings.Join(logicalText(e), "|"); got != want {
				t.Fatalf("width %d: %q", w, got)
			}
		}
	})
	t.Run("[TC-PDTERM-182] a shorter screen keeps the newest rows", func(t *testing.T) {
		e := newVT(20, 5)
		feed(e, "1\r\n2\r\n3\r\n4\r\n5")
		e.Resize(20, 3)
		if got := screenRows(e); strings.Join(got, ",") != "3,4,5" {
			t.Fatalf("screen %q", got)
		}
		if _, y := e.scr.CursorPosition(); y != 2 {
			t.Fatalf("cursor row %d", y)
		}
		e.Resize(20, 5)
		if got := screenRows(e); strings.Join(got, ",") != "1,2,3,4,5" {
			t.Fatalf("growing back: %q", got)
		}
		invariants(t, e)
	})
	t.Run("[TC-PDTERM-182] a cleared screen keeps its prompt at the top", func(t *testing.T) {
		e := newVT(40, 6)
		feed(e, "a\r\nb\r\nc\r\n\x1b[H\x1b[2J$ ")
		for _, size := range [][2]int{{30, 6}, {30, 3}, {50, 10}} {
			e.Resize(size[0], size[1])
			if x, y := e.scr.CursorPosition(); y != 0 || x != 2 {
				t.Fatalf("%v: cursor %d,%d, screen %q", size, x, y, screenRows(e))
			}
			if e.ScrollbackLen() != 3 {
				t.Fatalf("%v: scrollback %d lines", size, e.ScrollbackLen())
			}
		}
	})
	t.Run("[TC-PDTERM-182] the cursor keeps its place in the line", func(t *testing.T) {
		e := newVT(40, 6)
		feed(e, "hello world")
		e.Resize(5, 6)
		if x, y := e.scr.CursorPosition(); x != 1 || y != 2 {
			t.Fatalf("cursor %d,%d on %q", x, y, screenRows(e))
		}
		e.Resize(40, 6)
		if x, y := e.scr.CursorPosition(); x != 11 || y != 0 {
			t.Fatalf("cursor back at %d,%d", x, y)
		}
		e = newVT(40, 6)
		feed(e, "$ ")
		e.Resize(30, 6)
		if x, _ := e.scr.CursorPosition(); x != 2 {
			t.Fatalf("the space after the prompt was lost: x=%d", x)
		}
	})
	t.Run("[TC-PDTERM-182] a pending wrap is kept and released", func(t *testing.T) {
		e := newVT(10, 4)
		feed(e, digits(10))
		e.Resize(20, 4)
		feed(e, "X")
		if got := logicalText(e); got[0] != digits(10)+"X" || e.LineInfo(1).Wrapped {
			t.Fatalf("after widening: %q", got)
		}
		e = newVT(20, 4)
		feed(e, digits(10))
		e.Resize(10, 4)
		if !e.atPhantom {
			t.Fatal("a cursor at the end of a full row should be pending a wrap")
		}
		feed(e, "Y")
		if got := logicalText(e); got[0] != digits(10)+"Y" || !e.LineInfo(1).Wrapped {
			t.Fatalf("after narrowing: %q", got)
		}
	})
	t.Run("[TC-PDTERM-182] the main screen rewraps while a full-screen program is on the alternate one", func(t *testing.T) {
		e := newVT(40, 5)
		feed(e, long+"\r\n$ \x1b[?1049h\x1b[Hfull screen app")
		e.Resize(20, 5)
		invariants(t, e)
		feed(e, "\x1b[?1049l")
		if got := logicalText(e); got[0] != long {
			t.Fatalf("main screen after the alternate one: %q", got)
		}
		if x, _ := e.scr.CursorPosition(); x != 2 {
			t.Fatalf("main cursor x=%d", x)
		}
	})
	t.Run("[TC-PDTERM-182] tracked rows follow their text", func(t *testing.T) {
		e := newVT(40, 3)
		for i := range 20 {
			feed(e, fmt.Sprintf("line %02d %s\r\n", i, long))
		}
		target := 10 // scrollback line 10 is the start of "line 05"
		if lineText(e.Scrollback().Line(target)) == "" || !strings.HasPrefix(lineText(e.Scrollback().Line(target)), "line 05") {
			t.Fatalf("setup: line %d is %q", target, lineText(e.Scrollback().Line(target)))
		}
		moved := e.ResizeTracking(20, 3, []int{target})
		if got := lineText(e.Scrollback().Line(moved[0])); !strings.HasPrefix(got, "line 05") {
			t.Fatalf("tracked row went to %d: %q", moved[0], got)
		}
	})
}

func TestNativeVTScrollback(t *testing.T) {
	t.Run("[TC-PDTERM-183] the scrollback info stays in step and Pushed keeps counting", func(t *testing.T) {
		e := NewEmulator(10, 2)
		e.SetScrollbackSize(3)
		for i := range 10 {
			feed(e, fmt.Sprintf("%d\r\n", i))
		}
		invariants(t, e)
		if e.ScrollbackLen() != 3 || e.Scrollback().Pushed() != 9 {
			t.Fatalf("len %d pushed %d", e.ScrollbackLen(), e.Scrollback().Pushed())
		}
		e.Scrollback().SetMaxLines(1)
		e.Scrollback().SetMaxLines(3)
		invariants(t, e)
		e.Resize(5, 4)
		invariants(t, e)
		e.ClearScrollback()
		invariants(t, e)
	})
}

// TestNativeVTReflowFuzz writes random lines and resizes at random, and checks
// that no text is lost: the characters of all logical lines, in order, stay
// the same.
func TestNativeVTReflowFuzz(t *testing.T) {
	t.Run("[TC-PDTERM-182] random output and resizes keep every character", func(t *testing.T) {
		r := rand.New(rand.NewSource(7))
		alphabet := []string{"a", "b", "c", " ", "가", "나", "x", "-"}
		for round := range 30 {
			e := newVT(10+r.Intn(50), 3+r.Intn(10))
			var b strings.Builder
			for range 1 + r.Intn(12) {
				for range r.Intn(140) {
					b.WriteString(alphabet[r.Intn(len(alphabet))])
				}
				b.WriteString("\r\n")
			}
			b.WriteString("$ ")
			feed(e, b.String())
			want := strings.ReplaceAll(strings.Join(logicalText(e), ""), " ", "")
			for step := range 25 {
				e.Resize(2+r.Intn(70), 2+r.Intn(15))
				invariants(t, e)
				if got := strings.ReplaceAll(strings.Join(logicalText(e), ""), " ", ""); got != want {
					t.Fatalf("round %d step %d (%dx%d): text changed\n got %q\nwant %q", round, step, e.Width(), e.Height(), got, want)
				}
			}
		}
	})
}

func BenchmarkNativeVTReflow(b *testing.B) {
	e := newVT(250, 60)
	r := rand.New(rand.NewSource(1))
	var sb strings.Builder
	for range 5000 {
		for range r.Intn(120) {
			sb.WriteByte(byte('a' + r.Intn(26)))
		}
		sb.WriteString("\r\n")
	}
	feed(e, sb.String())
	b.ResetTimer()
	for i := range b.N {
		if i%2 == 0 {
			e.Resize(200, 60)
		} else {
			e.Resize(250, 60)
		}
	}
}

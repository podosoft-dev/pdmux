package session

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/podosoft-dev/pdmux/agent/internal/vt"
)

// Soft wraps through the renderer: what a viewer's terminal records must match
// what the session has, so copying a wrapped line gives one line.

func wrapDigits(n int) string {
	var b strings.Builder
	for i := range n {
		b.WriteByte(byte('0' + i%10))
	}
	return b.String()
}

// wrapSession opens a session on a fake process and returns the engine, the
// session and a viewer of the given size.
func wrapSession(t *testing.T, cols, rows int) (*Engine, *running, *View) {
	t.Helper()
	p := &screenProcess{output: make(chan []byte, 8), exit: make(chan *int, 1), written: make(chan string, 64)}
	e := NewEngine(func(int, int, string) (Process, error) { return p, nil })
	t.Cleanup(e.Close)
	view, info, err := e.Open(Request{Action: "create", Name: "wrap", Cols: cols, Rows: rows})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(view.Close)
	<-view.Frames()
	return e, e.sessions[info.ID], view
}

// draw writes output into the session and renders the viewer, returning the
// frame bytes.
func draw(t *testing.T, e *Engine, s *running, v *View, output string, full bool) string {
	t.Helper()
	e.mu.Lock()
	_, _ = s.vt.Write([]byte(output))
	e.render(s, v, full)
	e.mu.Unlock()
	frame := <-v.Frames()
	if frame.Screen == nil {
		t.Fatalf("no screen in %+v", frame)
	}
	return frame.Screen.Data
}

func replayText(term *vt.Emulator, y int) string {
	var b strings.Builder
	for x := range term.Width() {
		if c := term.CellAt(x, y); c != nil && !c.IsZero() {
			b.WriteString(c.Content)
		}
	}
	return strings.TrimRight(b.String(), " ")
}

// sameScreen checks that a terminal fed the frames shows the session's rows
// with the same soft wraps.
func sameScreen(t *testing.T, s *running, replay *vt.Emulator) {
	t.Helper()
	for y := range s.rows {
		if got, want := replayText(replay, y), replayText(s.vt, y); got != want {
			t.Fatalf("row %d: viewer has %q, session %q", y, got, want)
		}
		if got, want := replay.LineInfo(y), s.vt.LineInfo(y); got.Wrapped != want.Wrapped {
			t.Fatalf("row %d: viewer wrapped=%v, session %v", y, got.Wrapped, want.Wrapped)
		}
	}
}

func TestNativeSoftWrapFrames(t *testing.T) {
	long := "A" + wrapDigits(70) + "Z"
	t.Run("[TC-PDTERM-184] a viewer's terminal records the soft wraps the session has", func(t *testing.T) {
		e, s, v := wrapSession(t, 40, 6)
		data := draw(t, e, s, v, "\x1b[32mgreen\x1b[0m "+long+"\r\n$ ", true)
		if !strings.Contains(data, "\x1b[?7h") {
			t.Fatalf("no wrap in the frame: %q", data)
		}
		replay := vt.NewEmulator(40, 6)
		defer replay.Close()
		_, _ = replay.Write([]byte(data))
		sameScreen(t, s, replay)
		if got := strings.Join(lineStrings(replay), "|"); !strings.Contains(got, "green "+long) {
			t.Fatalf("the viewer cannot read the line back as one: %q", got)
		}
	})
	t.Run("[TC-PDTERM-184] a wide glyph that wrapped leaves no space in the viewer's line", func(t *testing.T) {
		e, s, v := wrapSession(t, 10, 4)
		data := draw(t, e, s, v, "abcdefghi가나", true)
		replay := vt.NewEmulator(10, 4)
		defer replay.Close()
		_, _ = replay.Write([]byte(data))
		sameScreen(t, s, replay)
		if got := lineStrings(replay); got[0] != "abcdefghi가나" {
			t.Fatalf("viewer line %q", got)
		}
	})
	t.Run("[TC-PDTERM-184] a wrapped line ending on the bottom row does not scroll the viewer", func(t *testing.T) {
		e, s, v := wrapSession(t, 40, 3)
		data := draw(t, e, s, v, wrapDigits(120), true)
		replay := vt.NewEmulator(40, 3)
		defer replay.Close()
		_, _ = replay.Write([]byte(data))
		sameScreen(t, s, replay)
		if replay.ScrollbackLen() != 0 {
			t.Fatalf("the viewer scrolled %d rows", replay.ScrollbackLen())
		}
	})
	t.Run("[TC-PDTERM-184] partial redraws keep and drop the wraps the session keeps and drops", func(t *testing.T) {
		e, s, v := wrapSession(t, 40, 6)
		replay := vt.NewEmulator(40, 6)
		defer replay.Close()
		_, _ = replay.Write([]byte(draw(t, e, s, v, long, true)))
		// Only the row above changes.
		_, _ = replay.Write([]byte(draw(t, e, s, v, "\x1b[1;1HB\x1b[2;33H", false)))
		sameScreen(t, s, replay)
		// A line feed into the continued row ends the wrap there.
		_, _ = replay.Write([]byte(draw(t, e, s, v, "\x1b[1;1H\n", false)))
		if s.vt.LineInfo(1).Wrapped {
			t.Fatal("setup: the session still has the wrap")
		}
		sameScreen(t, s, replay)
	})
	t.Run("[TC-PDTERM-184] no wraps on the alternate screen or in a view that cuts rows", func(t *testing.T) {
		e, s, v := wrapSession(t, 40, 6)
		if data := draw(t, e, s, v, "\x1b[?1049h"+long, true); strings.Contains(data, "\x1b[?7h") {
			t.Fatalf("alternate screen frame has a wrap: %q", data)
		}
		e2, s2, wide := wrapSession(t, 40, 6)
		narrow, _, err := e2.Open(Request{Action: "attach", ID: s2.info.ID, Cols: 20, Rows: 6})
		if err != nil {
			t.Fatal(err)
		}
		defer narrow.Close()
		<-narrow.Frames()
		_ = draw(t, e2, s2, wide, long, true)
		e2.mu.Lock()
		e2.render(s2, narrow, true)
		e2.mu.Unlock()
		if frame := <-narrow.Frames(); strings.Contains(frame.Screen.Data, "\x1b[?7h") {
			t.Fatalf("a 20-column view of a 40-column screen has a wrap: %q", frame.Screen.Data)
		}
	})
}

// lineStrings reads the screen a viewer's terminal shows back as lines,
// joining rows the way a copy does: a row it recorded as wrapped continues the
// row above, whose filler cell is not text.
func lineStrings(term *vt.Emulator) []string {
	var out []string
	for y := range term.Height() {
		var b strings.Builder
		for x := range term.Width() {
			if x == term.Width()-1 && y+1 < term.Height() && term.LineInfo(y).Pad && term.LineInfo(y+1).Wrapped {
				break
			}
			if c := term.CellAt(x, y); c != nil && !c.IsZero() {
				b.WriteString(c.Content)
			}
		}
		if y > 0 && term.LineInfo(y).Wrapped {
			out[len(out)-1] += b.String()
		} else {
			out = append(out, b.String())
		}
	}
	for i := range out {
		out[i] = strings.TrimRight(out[i], " ")
	}
	return out
}

func TestNativeSoftWrapHistory(t *testing.T) {
	long := "A" + wrapDigits(70) + "Z"
	t.Run("[TC-PDTERM-185] the history holds the lines the program wrote", func(t *testing.T) {
		e, s, v := wrapSession(t, 40, 4)
		_ = draw(t, e, s, v, "one\r\n"+long+"\r\ntwo\r\n"+long+long, true)
		lines, alternate, err := e.History(s.info.ID)
		if err != nil || alternate {
			t.Fatal(err, alternate)
		}
		var plain []string
		for _, line := range lines {
			plain = append(plain, strings.TrimRight(ansi.Strip(line), " "))
		}
		if strings.Join(plain, "|") != "one|"+long+"|two|"+long+long {
			t.Fatalf("history %q", plain)
		}
	})
	t.Run("[TC-PDTERM-186] a reader keeps reading the same text while another viewer resizes", func(t *testing.T) {
		e, s, reader := wrapSession(t, 40, 4)
		var b strings.Builder
		for i := range 30 {
			fmt.Fprintf(&b, "line %02d %s\r\n", i, long)
		}
		_ = draw(t, e, s, reader, b.String(), true)
		other, _, err := e.Open(Request{Action: "attach", ID: s.info.ID, Cols: 40, Rows: 4})
		if err != nil {
			t.Fatal(err)
		}
		defer other.Close()
		<-other.Frames()
		top := func() string {
			e.mu.Lock()
			defer e.mu.Unlock()
			return replayTextLine(s.vt.Scrollback().Line(s.vt.ScrollbackLen() - reader.history))
		}
		// Scroll back until the top row is the start of a line.
		_ = reader.Apply(Request{Action: "history", Y: 20})
		<-reader.Frames()
		for range 4 {
			if strings.HasPrefix(top(), "line ") {
				break
			}
			_ = reader.Apply(Request{Action: "history", Y: 1})
			<-reader.Frames()
		}
		before := top()
		if !strings.HasPrefix(before, "line ") {
			t.Fatalf("setup: reading %q", before)
		}
		// Another viewer resizes and takes the screen: everything rewraps.
		_ = other.Apply(Request{Action: "resize", Cols: 25, Rows: 4})
		if after := top(); !strings.HasPrefix(after, before[:7]) {
			t.Fatalf("the reader moved from %q to %q", before, after)
		}
	})
	t.Run("[TC-PDTERM-186] a blank newest line does not send a reader to the oldest line", func(t *testing.T) {
		e, s, reader := wrapSession(t, 40, 3)
		_ = draw(t, e, s, reader, "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n", true)
		_ = reader.Apply(Request{Action: "history", Y: 2})
		<-reader.Frames()
		e.mu.Lock()
		before := replayTextLine(s.vt.Scrollback().Line(s.vt.ScrollbackLen() - reader.history))
		e.mu.Unlock()
		// Output whose newest scrolled-off line is blank, through the pump.
		s.process.(*screenProcess).output <- []byte("\r\n\r\n\r\n")
		waitFor(t, func() bool {
			e.mu.Lock()
			defer e.mu.Unlock()
			return s.vt.Scrollback().Pushed() >= 7
		})
		e.mu.Lock()
		after := replayTextLine(s.vt.Scrollback().Line(s.vt.ScrollbackLen() - reader.history))
		e.mu.Unlock()
		if after != before {
			t.Fatalf("the reader moved from %q to %q", before, after)
		}
	})
}

func replayTextLine(cells []uv.Cell) string { return strings.TrimRight(ansi.Strip(renderCells(cells)), " ") }

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition did not become true")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestNativeSoftWrapGolden keeps the frame a browser test feeds into a real
// xterm.js (packages/ui/test/geometry/soft-wrap-copy.spec.ts) equal to what the
// renderer draws. PDMUX_UPDATE_GOLDEN=1 rewrites it.
func TestNativeSoftWrapGolden(t *testing.T) {
	t.Run("[TC-PDTERM-188] the frame the browser copy test uses is the renderer's", func(t *testing.T) {
		e, s, v := wrapSession(t, 40, 6)
		long := "A" + wrapDigits(70) + "Z"
		data := draw(t, e, s, v, "first "+long+"\r\n"+strings.Repeat("k", 39)+"가나다\r\n$ ", true)
		path := filepath.Join("testdata", "soft-wrap-frame.txt")
		if os.Getenv("PDMUX_UPDATE_GOLDEN") == "1" {
			if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(want) != data {
			t.Fatalf("the renderer changed; check the frame and rerun with PDMUX_UPDATE_GOLDEN=1\n got %q\nwant %q", data, want)
		}
	})
}

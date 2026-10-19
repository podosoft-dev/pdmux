package session

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/vt"
)

type screenProcess struct {
	output  chan []byte
	exit    chan *int
	written chan string
	once    sync.Once
}

func (p *screenProcess) Pid() *int               { value := 123; return &value }
func (p *screenProcess) Write(data string) error { p.written <- data; return nil }
func (p *screenProcess) Resize(int, int) error   { return nil }
func (p *screenProcess) Kill()                   { p.once.Do(func() { close(p.output); code := 0; p.exit <- &code }) }
func (p *screenProcess) Output() <-chan []byte   { return p.output }
func (p *screenProcess) Exit() <-chan *int       { return p.exit }

func TestNativeScreenState(t *testing.T) {
	t.Run("[TC-PDTERM-022] bounded viewer snapshots preserve Unicode, modes and cursor offsets", func(t *testing.T) {
		p := &screenProcess{output: make(chan []byte, 8), exit: make(chan *int, 1), written: make(chan string, 64)}
		e := NewEngine(func(int, int, string) (Process, error) { return p, nil })
		defer e.Close()
		large, info, err := e.Open(Request{Action: "create", Name: "state", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer large.Close()
		small, _, err := e.Open(Request{Action: "attach", ID: info.ID, Cols: 10, Rows: 4})
		if err != nil {
			t.Fatal(err)
		}
		defer small.Close()
		p.output <- []byte("\x1b[2J\x1b[H\ud55c\uae00界🙂e\u0301\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[6n")
		select {
		case response := <-p.written:
			if !strings.Contains(response, "R") {
				t.Fatalf("query was not answered centrally: %q", response)
			}
		case <-time.After(time.Second):
			t.Fatal("VT query stalled without a consuming viewer")
		}
		deadline := time.Now().Add(time.Second)
		for {
			e.mu.Lock()
			painted := e.sessions[info.ID].vt.CellAt(0, 0).Content == "\ud55c"
			e.mu.Unlock()
			if painted {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("output was not parsed")
			}
			time.Sleep(time.Millisecond)
		}
		if err := small.Apply(Request{Action: "viewport", X: 1, Y: 0}); err != nil {
			t.Fatal(err)
		}
		frame := <-small.Frames()
		if frame.Screen == nil || !strings.Contains(frame.Screen.Data, "\x1b[?2004h") || !strings.Contains(frame.Screen.Data, "\x1b[?1006h") {
			t.Fatalf("input modes missing: %+v", frame)
		}
		viewer := vt.NewEmulator(10, 4)
		defer viewer.Close()
		if _, err := viewer.Write([]byte(frame.Screen.Data)); err != nil {
			t.Fatal(err)
		}
		if cell := viewer.CellAt(0, 0); cell.Content != " " {
			t.Fatalf("left edge paints half a wide glyph: %+v", cell)
		}
		if cell := viewer.CellAt(1, 0); cell.Content != "\uae00" {
			t.Fatalf("Unicode viewport is corrupt: %+v", cell)
		}
		if err := small.Apply(Request{Action: "input", Data: "\x1b[<0;2;3M"}); err != nil {
			t.Fatal(err)
		}
		select {
		case data := <-p.written:
			if data != "\x1b[<0;3;3M" {
				t.Fatalf("mouse did not address the canonical screen: %q", data)
			}
		case <-time.After(time.Second):
			t.Fatal("mouse input missing")
		}
		// Leave the old frame unread. Refresh must replace it with a complete
		// snapshot, so a slow viewer cannot miss rows that changed earlier.
		if err := small.Apply(Request{Action: "viewport", X: 0, Y: 0}); err != nil {
			t.Fatal(err)
		}
		if err := small.Apply(Request{Action: "refresh"}); err != nil {
			t.Fatal(err)
		}
		frame = <-small.Frames()
		if frame.Screen == nil || !strings.Contains(frame.Screen.Data, "\x1b[2J") || !strings.Contains(frame.Screen.Data, "\ud55c\uae00界🙂e\u0301") {
			t.Fatal("slow viewer did not receive a complete Unicode snapshot")
		}
	})
	t.Run("[TC-PDTERM-023] an accepted idle shutdown cannot race a new program", func(t *testing.T) {
		e := NewEngine(func(int, int, string) (Process, error) { t.Fatal("spawn after shutdown"); return nil, nil })
		if err := e.StopIdle(); err != nil {
			t.Fatal(err)
		}
		if _, _, err := e.Open(Request{Action: "create", Name: "late"}); err == nil {
			t.Fatal("shutdown admitted a new session")
		}
	})
}

func TestNativeColorsAndHistory(t *testing.T) {
	t.Run("[TC-PDTERM-022] preserves indexed and truecolor cells through snapshots and history", func(t *testing.T) {
		source := vt.NewEmulator(40, 3)
		defer source.Close()
		_, _ = source.Write([]byte("\x1b[31mRED\x1b[38;5;202mINDEX\x1b[38;2;12;34;56mRGB\x1b[0m"))
		row := renderRow(source, 0, 0, 40)
		target := vt.NewEmulator(40, 3)
		defer target.Close()
		_, _ = target.Write([]byte(row))
		for _, x := range []int{0, 3, 8} {
			if !source.CellAt(x, 0).Style.Equal(&target.CellAt(x, 0).Style) || target.CellAt(x, 0).Style.Fg == nil {
				t.Fatalf("color lost at %d: %q", x, row)
			}
		}
	})
	t.Run("[TC-PDTERM-130] history stays readable while output arrives and does not capture selection", func(t *testing.T) {
		p := &screenProcess{output: make(chan []byte, 8), exit: make(chan *int, 1), written: make(chan string, 64)}
		e := NewEngine(func(int, int, string) (Process, error) { return p, nil })
		defer e.Close()
		view, info, err := e.Open(Request{Action: "create", Name: "scroll", Cols: 40, Rows: 4})
		if err != nil {
			t.Fatal(err)
		}
		defer view.Close()
		<-view.Frames()
		e.mu.Lock()
		s := e.sessions[info.ID]
		_, _ = s.vt.Write([]byte("one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\n\x1b[?1000h\x1b[?1006h"))
		e.mu.Unlock()
		_ = view.Apply(Request{Action: "history", Y: 2})
		first := <-view.Frames()
		if strings.Contains(first.Screen.Data, "\x1b[?1000h") {
			t.Fatal("history captures mouse instead of allowing selection")
		}
		e.mu.Lock()
		_, _ = s.vt.Write([]byte("seven\r\neight\r\n"))
		e.render(s, view, false)
		e.mu.Unlock()
		select {
		case <-view.Frames():
			t.Fatal("new output redraws a frozen history selection")
		case <-time.After(30 * time.Millisecond):
		}
	})
}

func TestNativeViewportInput(t *testing.T) {
	t.Run("[TC-PDTERM-022] batched mouse reports pan independently and pasted reports remain text", func(t *testing.T) {
		p := &screenProcess{output: make(chan []byte, 8), exit: make(chan *int, 1), written: make(chan string, 64)}
		e := NewEngine(func(int, int, string) (Process, error) { return p, nil })
		defer e.Close()
		large, info, err := e.Open(Request{Action: "create", Name: "input", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer large.Close()
		small, _, err := e.Open(Request{Action: "attach", ID: info.ID, Cols: 20, Rows: 5})
		if err != nil {
			t.Fatal(err)
		}
		defer small.Close()
		e.mu.Lock()
		_, _ = e.sessions[info.ID].vt.Write([]byte("\x1b[?1000h"))
		e.mu.Unlock()
		_ = small.Apply(Request{Action: "viewport", X: 10, Y: 5})
		reports := "\x1b[<64;2;3M\x1b[<65;4;5M"
		_ = small.Apply(Request{Action: "input", Data: reports})
		select {
		case data := <-p.written:
			if data != "\x1b[<64;12;8M\x1b[<65;14;10M" {
				t.Fatalf("batched mouse: %q", data)
			}
		case <-time.After(time.Second):
			t.Fatal("mouse input stalled")
		}
		if small.follow {
			t.Fatal("mouse input abandoned the manually panned viewport")
		}
		for _, chunk := range []string{"\x1b[200~", reports, "\x1b[201~"} {
			_ = small.Apply(Request{Action: "input", Data: chunk})
			select {
			case data := <-p.written:
				if data != chunk {
					t.Fatalf("paste changed: %q", data)
				}
			case <-time.After(time.Second):
				t.Fatal("paste stalled")
			}
		}
	})
}

func TestNativeExitInputModes(t *testing.T) {
	t.Run("[TC-PDTERM-130] late wheel and focus reports cannot type into a restored shell", func(t *testing.T) {
		p := &screenProcess{output: make(chan []byte, 8), exit: make(chan *int, 1), written: make(chan string, 64)}
		e := NewEngine(func(int, int, string) (Process, error) { return p, nil })
		defer e.Close()
		view, info, err := e.Open(Request{Action: "create", Name: "exit", Cols: 80, Rows: 24})
		if err != nil {
			t.Fatal(err)
		}
		defer view.Close()
		e.mu.Lock()
		s := e.sessions[info.ID]
		_, _ = s.vt.Write([]byte("\x1b[?1049h\x1b[?1003h\x1b[?1004h\x1b[?1000l\x1b[?1004l\x1b[?1049l"))
		e.render(s, view, true)
		e.mu.Unlock()
		frame := <-view.Frames()
		if strings.Contains(frame.Screen.Data, "\x1b[?1003h") {
			t.Fatal("resetting a mouse tracker left another tracker active")
		}
		for _, data := range []string{"\x1b[I", "\x1b[O", "\x1b[<64;2;3M"} {
			_ = view.Apply(Request{Action: "input", Data: data})
		}
		_ = view.Apply(Request{Action: "input", Data: "\x1b[B", Source: "wheel"})
		select {
		case data := <-p.written:
			t.Fatalf("protocol report leaked to shell: %q", data)
		case <-time.After(30 * time.Millisecond):
		}
		_ = view.Apply(Request{Action: "input", Data: "\x1b[B"})
		select {
		case data := <-p.written:
			if data != "\x1b[B" {
				t.Fatalf("keyboard arrow changed: %q", data)
			}
		case <-time.After(time.Second):
			t.Fatal("keyboard arrow was swallowed")
		}
	})
}

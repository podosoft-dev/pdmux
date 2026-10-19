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
		p.output <- []byte("\x1b[2J\x1b[H\ud55c\uae00界🙂e\u0301\x1b[?2004h\x1b[?1006h\x1b[6n")
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

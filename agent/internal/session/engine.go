package session

import (
	"crypto/rand"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

var validName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)

type Engine struct {
	mu       sync.Mutex
	spawn    Factory
	sessions map[string]*running
	lastUsed time.Time
	stopping bool
}

type running struct {
	info       Info
	process    Process
	vt         *vt.Emulator
	cols, rows int
	views      map[*View]struct{}
	modes      map[ansi.Mode]bool
	dirty      bool
	sequence   int
	closed     bool
	queryDone  chan struct{}
	input      chan queuedInput
	inputDone  chan struct{}
	lastTrim   time.Time
}

type queuedInput struct {
	data                string
	wheel, mouse, focus bool
}

func (s *running) mouseTracking() bool {
	for _, number := range []int{9, 1000, 1002, 1003} {
		if s.modes[ansi.DECMode(number)] {
			return true
		}
	}
	return false
}

// Recheck at the PTY writer too: reports queued for a TUI must not reach the
// shell after the TUI has restored the normal screen and input modes.
func (s *running) acceptsInput(input queuedInput) bool {
	mouse := s.mouseTracking()
	if input.wheel && !s.vt.IsAltScreen() && !mouse {
		return false
	}
	if input.mouse && !mouse {
		return false
	}
	return !input.focus || s.modes[ansi.DECMode(1004)]
}

type View struct {
	engine           *Engine
	session          *running
	cols, rows, x, y int
	follow           bool
	history          int
	last             []string
	historyRows      []string
	pasting          bool
	lastModes        string
	frames           chan Reply
	done             chan struct{}
	once             sync.Once
}

func NewEngine(spawn Factory) *Engine {
	return &Engine{spawn: spawn, sessions: make(map[string]*running), lastUsed: time.Now()}
}

func (e *Engine) List() []Info {
	e.mu.Lock()
	defer e.mu.Unlock()
	result := make([]Info, 0, len(e.sessions))
	for _, s := range e.sessions {
		info := s.info
		info.Cols, info.Rows = s.cols, s.rows
		info.Attached = len(s.views)
		result = append(result, info)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func (e *Engine) Idle(now time.Time) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.sessions) == 0 && now.Sub(e.lastUsed) >= IdleTimeout {
		e.stopping = true
	}
	return e.stopping
}

// StopIdle refuses shutdown while a program is running and prevents a concurrent
// attachment from starting a program after shutdown has been accepted.
func (e *Engine) StopIdle() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.sessions) != 0 {
		return fmt.Errorf("SESSION_ENGINE_BUSY")
	}
	e.stopping = true
	return nil
}

func (e *Engine) Open(request Request) (*View, Info, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stopping {
		return nil, Info{}, fmt.Errorf("SESSION_ENGINE_STOPPING")
	}
	viewers := 0
	for _, existing := range e.sessions {
		viewers += len(existing.views)
	}
	if viewers >= MaxViewers {
		return nil, Info{}, fmt.Errorf("SESSION_VIEWER_LIMIT")
	}
	var s *running
	if request.ID != "" {
		s = e.sessions[request.ID]
		if s == nil {
			return nil, Info{}, fmt.Errorf("SESSION_NOT_FOUND")
		}
	} else {
		for _, candidate := range e.sessions {
			if candidate.info.Name == request.Name {
				s = candidate
				break
			}
		}
	}
	if s == nil {
		if request.Action != "create" && request.Action != "ensure" {
			return nil, Info{}, fmt.Errorf("SESSION_NOT_FOUND")
		}
		if !validName.MatchString(request.Name) {
			return nil, Info{}, fmt.Errorf("INVALID_SESSION_NAME")
		}
		if len(e.sessions) >= MaxSessions {
			return nil, Info{}, fmt.Errorf("SESSION_LIMIT")
		}
		cols, rows := dimensions(request.Cols, request.Rows)
		p, err := e.spawn(cols, rows, request.Directory)
		if err != nil {
			return nil, Info{}, fmt.Errorf("SESSION_START_FAILED: %w", err)
		}
		s = &running{info: Info{ID: randomID(), Name: request.Name, PID: p.Pid()}, process: p, vt: vt.NewEmulator(cols, rows), cols: cols, rows: rows, views: make(map[*View]struct{}), modes: make(map[ansi.Mode]bool), dirty: true, queryDone: make(chan struct{}), input: make(chan queuedInput, 64), inputDone: make(chan struct{})}
		s.vt.SetScrollbackSize(HistoryLines)
		s.vt.SetCallbacks(vt.Callbacks{
			EnableMode: func(mode ansi.Mode) {
				switch mode {
				case ansi.DECMode(9), ansi.DECMode(1000), ansi.DECMode(1002), ansi.DECMode(1003):
					for _, number := range []int{9, 1000, 1002, 1003} {
						s.modes[ansi.DECMode(number)] = false
					}
				}
				s.modes[mode] = true
			},
			AltScreen: func(bool) {
				for v := range s.views {
					if v.follow {
						v.x, v.y = 0, 0
						v.last = nil
					}
				}
			},
			DisableMode: func(mode ansi.Mode) {
				switch mode {
				case ansi.DECMode(9), ansi.DECMode(1000), ansi.DECMode(1002), ansi.DECMode(1003):
					for _, number := range []int{9, 1000, 1002, 1003} {
						s.modes[ansi.DECMode(number)] = false
					}
				default:
					s.modes[mode] = false
				}
			},
		})
		e.sessions[s.info.ID] = s
		// One bounded writer prevents an application that stopped reading input
		// from blocking the engine lock or other sessions.
		go func() {
			for {
				select {
				case <-s.inputDone:
					return
				case data := <-s.input:
					e.mu.Lock()
					allowed := s.acceptsInput(data)
					e.mu.Unlock()
					if allowed {
						_ = p.Write(data.data)
					}
				}
			}
		}()
		// The VT responds to terminal queries even while every viewer is detached.
		go func() {
			defer close(s.queryDone)
			buffer := make([]byte, 4096)
			for {
				n, err := s.vt.Read(buffer)
				if n > 0 {
					select {
					case s.input <- queuedInput{data: string(buffer[:n])}:
					default: /* An unresponsive application cannot grow the reply queue. */
					}
				}
				if err != nil {
					return
				}
			}
		}()
		go e.pump(s)
	} else if request.Action == "create" {
		return nil, Info{}, fmt.Errorf("SESSION_EXISTS")
	}
	cols, rows := dimensions(request.Cols, request.Rows)
	v := &View{engine: e, session: s, cols: cols, rows: rows, follow: true, frames: make(chan Reply, 1), done: make(chan struct{})}
	s.views[v] = struct{}{}
	e.resize(s)
	e.render(s, v, true)
	e.lastUsed = time.Now()
	return v, s.info, nil
}

func randomID() string {
	var bytes [16]byte
	_, _ = rand.Read(bytes[:])
	bytes[6] = bytes[6]&15 | 64
	bytes[8] = bytes[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:])
}

func dimensions(cols, rows int) (int, int) { return max(1, min(1000, cols)), max(1, min(500, rows)) }

func (e *Engine) pump(s *running) {
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	output := s.process.Output()
	for {
		select {
		case data, ok := <-output:
			if !ok {
				code := <-s.process.Exit()
				e.mu.Lock()
				s.closed = true
				delete(e.sessions, s.info.ID)
				for v := range s.views {
					e.render(s, v, true)
					final := Reply{}
					select {
					case final = <-v.frames:
					default:
					}
					final.Type = "exit"
					final.Code = code
					v.offer(final)
				}
				e.lastUsed = time.Now()
				e.mu.Unlock()
				// Stop the reply reader before VT.Close updates its closed flag.
				if pipe, ok := s.vt.InputPipe().(io.Closer); ok {
					_ = pipe.Close()
				}
				<-s.queryDone
				_ = s.vt.Close()
				close(s.inputDone)
				return
			}
			e.mu.Lock()
			previous := s.vt.Scrollback().Lines()
			var tail *uv.Cell
			if len(previous) > 0 && len(previous[len(previous)-1]) > 0 {
				tail = &previous[len(previous)-1][0]
			}
			_, _ = s.vt.Write(data)
			// Keep a reader anchored even when the bounded ring evicts old lines.
			added := s.vt.ScrollbackLen()
			if tail != nil {
				current := s.vt.Scrollback().Lines()
				for i := len(current) - 1; i >= 0; i-- {
					if len(current[i]) > 0 && &current[i][0] == tail {
						added = len(current) - i - 1
						break
					}
				}
			}
			for v := range s.views {
				if v.history > 0 {
					v.history = min(s.vt.ScrollbackLen(), v.history+added)
				}
			}
			if !s.dirty {
				for v := range s.views {
					e.render(s, v, false)
				}
			}
			s.dirty = true
			e.mu.Unlock()
		case <-ticker.C:
			e.mu.Lock()
			if s.dirty {
				if time.Since(s.lastTrim) >= 100*time.Millisecond {
					trimHistory(s.vt)
					s.lastTrim = time.Now()
				}
				for v := range s.views {
					e.render(s, v, false)
				}
				s.dirty = false
			}
			e.mu.Unlock()
		}
	}
}

func (e *Engine) resize(s *running) {
	cols, rows := 1, 1
	for v := range s.views {
		cols = max(cols, v.cols)
		rows = max(rows, v.rows)
	}
	if len(s.views) == 0 || cols == s.cols && rows == s.rows {
		return
	}
	s.cols, s.rows = cols, rows
	s.vt.Resize(cols, rows)
	_ = s.process.Resize(cols, rows)
	for v := range s.views {
		v.last = nil
	}
	s.dirty = true
}

func (v *View) Frames() <-chan Reply  { return v.frames }
func (v *View) Done() <-chan struct{} { return v.done }
func (v *View) offer(reply Reply) {
	select {
	case v.frames <- reply:
	default:
		select {
		case <-v.frames:
		default:
		}
		v.frames <- reply
	}
}

func (v *View) Apply(r Request) error {
	e := v.engine
	e.mu.Lock()
	defer e.mu.Unlock()
	if v.session.closed {
		return io.EOF
	}
	select {
	case <-v.done:
		return io.EOF
	default:
	}
	switch r.Action {
	case "input":
		literal := v.pasting || strings.Contains(r.Data, "\x1b[200~")
		input := queuedInput{wheel: r.Source == "wheel", mouse: !literal && mouseOnly(r.Data), focus: !literal && (r.Data == "\x1b[I" || r.Data == "\x1b[O")}
		if v.history > 0 && (input.wheel || input.mouse || input.focus) {
			return nil
		}
		if !v.session.acceptsInput(input) {
			return nil
		}
		if r.Source != "wheel" && !mouseOnly(r.Data) && r.Data != "\x1b[I" && r.Data != "\x1b[O" {
			wasHistory := v.history > 0
			v.follow = true
			v.history = 0
			v.historyRows = nil
			if wasHistory {
				v.last = nil
				e.render(v.session, v, true)
			}
		}
		data := r.Data
		if !v.pasting && mouseOnly(data) {
			data = translateMouse(data, v.x, v.y)
		}
		if start, end := strings.LastIndex(r.Data, "\x1b[200~"), strings.LastIndex(r.Data, "\x1b[201~"); start >= 0 || end >= 0 {
			v.pasting = start > end
		}
		if len(data) > 256<<10 {
			return fmt.Errorf("SESSION_INPUT_LIMIT")
		}
		for len(data) > 0 {
			end := min(4096, len(data))
			select {
			case v.session.input <- queuedInput{data: data[:end], wheel: input.wheel, mouse: input.mouse, focus: input.focus}:
				data = data[end:]
			default:
				return fmt.Errorf("SESSION_INPUT_BUSY")
			}
		}
		return nil
	case "resize":
		v.cols, v.rows = dimensions(r.Cols, r.Rows)
		v.historyRows = nil
		v.last = nil
		e.resize(v.session)
	case "viewport":
		v.historyRows = nil
		v.follow = r.Follow
		v.x = r.X
		v.y = r.Y
		v.last = nil
		if r.Follow {
			v.history = 0
		}
	case "history":
		v.historyRows = nil
		v.history = max(0, min(v.session.vt.ScrollbackLen(), v.history+r.Y))
		v.last = nil
		v.follow = v.history == 0
	case "refresh":
		v.last = nil
	default:
		return fmt.Errorf("INVALID_SESSION_ACTION")
	}
	e.render(v.session, v, true)
	return nil
}

func (v *View) Close() {
	v.once.Do(func() {
		e := v.engine
		e.mu.Lock()
		delete(v.session.views, v)
		e.resize(v.session)
		e.lastUsed = time.Now()
		close(v.done)
		e.mu.Unlock()
	})
}

func (e *Engine) Terminate(id string) error {
	e.mu.Lock()
	s := e.sessions[id]
	e.mu.Unlock()
	if s == nil {
		return fmt.Errorf("SESSION_NOT_FOUND")
	}
	s.process.Kill()
	return nil
}

func (e *Engine) History(id string) ([]string, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.sessions[id]
	if s == nil {
		return nil, false, fmt.Errorf("SESSION_NOT_FOUND")
	}
	lines := []string{}
	if !s.vt.IsAltScreen() {
		for _, row := range s.vt.Scrollback().Lines() {
			lines = append(lines, renderCells(row))
		}
	}
	for y := 0; y < s.rows; y++ {
		lines = append(lines, renderRow(s.vt, 0, y, s.cols))
	}
	return lines, s.vt.IsAltScreen(), nil
}

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
	// closing is set once the helper itself is shutting down (a signal, the OS
	// going down). Sessions that end after it keep their restore entry: they did
	// not end, the machine did.
	closing bool
	restore *restoreStore
}

type running struct {
	titles     windowTitleFilter
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
	// terminated marks an explicit terminate, which must never come back.
	terminated bool
	// restoredAt is when this session was reopened after a reboot; zero otherwise.
	restoredAt time.Time
	// active is the viewer that last typed into or resized the session. The screen
	// takes its size, so the person working in it gets lines wrapped to their pane.
	active *View
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

// EnableRestore keeps root/restore.json for this engine under the boot bootID.
// An empty bootID leaves restore off — see openRestoreStore.
func (e *Engine) EnableRestore(root, bootID string, now func() time.Time) {
	store := openRestoreStore(root, bootID, now)
	e.mu.Lock()
	e.restore = store
	e.mu.Unlock()
}

// MarkClosing records that the helper is going down, before it kills anything.
func (e *Engine) MarkClosing() {
	e.mu.Lock()
	e.closing = true
	e.mu.Unlock()
}

// RefreshRestore copies each live session's size and, where the platform exposes
// it, current directory into its restore entry.
func (e *Engine) RefreshRestore() {
	e.mu.Lock()
	store := e.restore
	type snapshot struct {
		id, name   string
		pid        *int
		cols, rows int
	}
	live := make([]snapshot, 0, len(e.sessions))
	for _, s := range e.sessions {
		live = append(live, snapshot{id: s.info.ID, name: s.info.Name, pid: s.info.PID, cols: s.cols, rows: s.rows})
	}
	e.mu.Unlock()
	if store == nil {
		return
	}
	for _, s := range live {
		directory := processDirectory(s.pid)
		store.update(s.id, func(entry *RestoreEntry) {
			entry.Name, entry.Cols, entry.Rows = s.name, s.cols, s.rows
			if directory != "" {
				entry.Cwd = directory
			}
		})
	}
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

// Rename changes only the name index. UUIDs, PTYs, viewers and history stay alive.
func (e *Engine) Rename(id, name string) (Info, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.sessions[id]
	if s == nil {
		return Info{}, fmt.Errorf("SESSION_NOT_FOUND")
	}
	if !validName.MatchString(name) {
		return Info{}, fmt.Errorf("INVALID_SESSION_NAME")
	}
	for _, other := range e.sessions {
		if other != s && other.info.Name == name {
			return Info{}, fmt.Errorf("SESSION_EXISTS")
		}
	}
	s.info.Name = name
	e.restore.update(id, func(entry *RestoreEntry) { entry.Name = name })
	info := s.info
	info.Cols, info.Rows, info.Attached = s.cols, s.rows, len(s.views)
	return info, nil
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
	// A UUID that is not running may belong to a session the machine's restart
	// ended. Only then is it reopened, under the same UUID, so every pane and
	// every saved layout that points at it lands on the new shell.
	var restoring *RestoreEntry
	if request.ID != "" {
		s = e.sessions[request.ID]
		if s == nil {
			entry, ok := e.restore.restorable(request.ID)
			if !ok {
				return nil, Info{}, fmt.Errorf("SESSION_NOT_FOUND")
			}
			restoring = &entry
		}
	} else {
		for _, candidate := range e.sessions {
			if candidate.info.Name == request.Name {
				s = candidate
				break
			}
		}
	}
	restored := false
	if s == nil {
		id, name, directory := randomID(), request.Name, request.Directory
		switch {
		case restoring != nil:
			id, name, directory = restoring.UUID, freeName(restoring.Name, e.nameTaken), restoreDirectory(restoring.Cwd)
		case request.Action != "create" && request.Action != "ensure":
			return nil, Info{}, fmt.Errorf("SESSION_NOT_FOUND")
		case request.Restore && request.Action == "ensure":
			// The multiplexer session this name belonged to is gone. Start where a
			// native session of the same name last was, if one was recorded.
			if entry, ok := e.restore.restorableByName(request.Name); ok {
				directory = restoreDirectory(entry.Cwd)
				e.restore.forget(entry.UUID)
			}
		}
		if !validName.MatchString(name) {
			return nil, Info{}, fmt.Errorf("INVALID_SESSION_NAME")
		}
		if len(e.sessions) >= MaxSessions {
			return nil, Info{}, fmt.Errorf("SESSION_LIMIT")
		}
		cols, rows := dimensions(request.Cols, request.Rows)
		p, err := e.spawn(cols, rows, directory)
		if err != nil {
			return nil, Info{}, fmt.Errorf("SESSION_START_FAILED: %w", err)
		}
		e.restore.record(RestoreEntry{UUID: id, Name: name, Cwd: directory, Cols: cols, Rows: rows})
		restored = restoring != nil
		s = &running{info: Info{ID: id, Name: name, PID: p.Pid()}, process: p, vt: vt.NewEmulator(cols, rows), cols: cols, rows: rows, views: make(map[*View]struct{}), modes: make(map[ansi.Mode]bool), dirty: true, queryDone: make(chan struct{}), input: make(chan queuedInput, 64), inputDone: make(chan struct{})}
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
	if restored {
		s.restoredAt = e.lastUsed
	}
	info := s.info
	// Every pane of a layout reattaches within moments of the agent's return, so
	// each of them is told; a viewer arriving long after is not.
	if !s.restoredAt.IsZero() && e.lastUsed.Sub(s.restoredAt) < restoredNoticeWindow {
		info.Restored = RestoredReboot
	}
	return v, info, nil
}

func (e *Engine) nameTaken(name string) bool {
	for _, s := range e.sessions {
		if s.info.Name == name {
			return true
		}
	}
	return false
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
				// Only a session alive when the machine went down may come back. A
				// shell that ended while this helper was running normally — its own
				// exit, a signal, or an explicit terminate — has ended for good.
				// Once the helper is closing (the OS is shutting it down) the shells
				// it kills keep their entries; a terminate never does.
				if s.terminated || !e.closing {
					e.restore.forget(s.info.ID)
				}
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
			data = s.titles.filter(data)
			if len(data) == 0 {
				continue
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

// resize sizes the screen to the viewer that last typed into or resized it, or,
// before anyone has, to the largest viewer, so a viewer that only watches never
// shrinks another.
// Other viewers see a viewport of that screen.
func (e *Engine) resize(s *running) {
	cols, rows := 1, 1
	if s.active != nil {
		cols, rows = s.active.cols, s.active.rows
	} else {
		for v := range s.views {
			cols = max(cols, v.cols)
			rows = max(rows, v.rows)
		}
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
		if Typing(r.Data, r.Source) {
			if v.session.active != v {
				v.session.active = v
				e.resize(v.session)
			}
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
		// Resizing a pane is using it, as typing is.
		v.session.active = v
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
		if v.session.active == v {
			v.session.active = nil
		}
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
	e.mu.Lock()
	s.terminated = true
	e.mu.Unlock()
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

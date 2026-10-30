package term

import (
	"context"
	"time"
	"unicode/utf8"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
)

func (m *Manager) nativeFor(id string) *session.Attachment {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.native[id]
}

// openNative attaches a native session. restore marks a session opened in place
// of a tmux session that is gone: the helper starts it where a native session of
// that name last was, and the ready frame says it was reopened.
func (m *Manager) openNative(id string, target protocol.TerminalTarget, restore bool) {
	if target.Kind == protocol.TerminalShell {
		m.fail(id, "INVALID_SESSION_TARGET")
		return
	}
	if m.nativeClient == nil {
		m.fail(id, "NATIVE_SESSIONS_UNSUPPORTED")
		return
	}
	m.mu.Lock()
	if _, ok := m.opening[id]; ok {
		m.mu.Unlock()
		return
	}
	if m.native[id] != nil || m.terminals[id] != nil {
		m.mu.Unlock()
		return
	}
	if len(m.native)+len(m.terminals)+len(m.opening) >= m.maxTerminals {
		m.mu.Unlock()
		m.fail(id, "terminal limit reached")
		return
	}
	m.openSerial++
	ticket := m.openSerial
	m.opening[id] = ticket
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if m.opening[id] == ticket {
			delete(m.opening, id)
		}
		m.mu.Unlock()
	}()
	name := DefaultSession
	if target.Session != nil {
		name = *target.Session
	}
	intent := "attach"
	if target.Intent != nil {
		intent = *target.Intent
	}
	request := session.Request{Action: intent, Name: name, Cols: target.Cols, Rows: target.Rows, Restore: restore}
	if target.SessionID != nil {
		request.ID = *target.SessionID
		request.Action = "attach"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	attachment, err := m.nativeClient.Attach(ctx, request)
	if err != nil {
		m.fail(id, err.Error())
		return
	}
	m.mu.Lock()
	if m.opening[id] != ticket {
		m.mu.Unlock()
		attachment.Close()
		return
	}
	m.native[id] = attachment
	m.mu.Unlock()
	m.nativeOpened(attachment, target.Cols, target.Rows)
	m.opened.Add(1)
	backend := "native"
	ready := &protocol.TerminalReady{Type: protocol.TermReady, TermID: id, Pid: attachment.Info.PID, Backend: &backend, SessionID: &attachment.Info.ID}
	if restore || attachment.Info.Restored == session.RestoredReboot {
		ready.Restored = &protocol.TerminalRestored{Reason: session.RestoredReboot}
		m.logger.Info("Reopened a session after a host restart", log.F("termId", id), log.F("target", "session:"+attachment.Info.Name))
	}
	m.emit(ready)
	go func() {
		defer attachment.Close()
		defer func() {
			m.mu.Lock()
			if m.native[id] == attachment {
				delete(m.native, id)
			}
			m.mu.Unlock()
			m.nativeReleased(attachment)
		}()
		for reply := range attachment.Replies() {
			if m.nativeFor(id) != attachment {
				return
			}
			if reply.Screen != nil {
				m.emitScreen(id, *reply.Screen)
			}
			if reply.Type == "exit" {
				m.emit(&protocol.TerminalExit{Type: protocol.TermExit, TermID: id, Code: reply.Code})
				return
			}
			if reply.Error != "" {
				m.fail(id, reply.Error)
				return
			}
		}
	}()
}

func (m *Manager) emitScreen(id string, screen session.Screen) {
	data := screen.Data
	for len(data) > 0 {
		end := min(len(data), 48<<10)
		for end < len(data) && !utf8.RuneStart(data[end]) {
			end--
		}
		m.emit(&protocol.TerminalScreen{Type: protocol.TermScreen, TermID: id, Data: data[:end], Sequence: screen.Sequence, Cols: screen.Cols, Rows: screen.Rows, CanvasCols: screen.CanvasCols, CanvasRows: screen.CanvasRows, X: screen.X, Y: screen.Y, Follow: screen.Follow, Alternate: &screen.Alternate, History: &screen.History})
		data = data[end:]
	}
}

func (m *Manager) nativeControl(frame *protocol.TerminalSessionControl) {
	result := &protocol.TerminalSessionResult{Type: protocol.TermSessionResult, TermID: frame.TermID, Lines: []string{}}
	if m.nativeClient == nil {
		result.Error = "NATIVE_SESSIONS_UNSUPPORTED"
		m.emit(result)
		return
	}
	if frame.Action != "history" && frame.Action != "terminate" && frame.Action != "rename" {
		result.Error = "INVALID_SESSION_ACTION"
		m.emit(result)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	name := ""
	if frame.Name != nil {
		name = *frame.Name
	}
	reply, err := m.nativeClient.Request(ctx, session.Request{Action: frame.Action, ID: frame.SessionID, Name: name})
	if err != nil {
		result.Error = truncate(err.Error(), 512)
		if frame.Action == "rename" && result.Error == "INVALID_SESSION_ACTION" {
			result.Error = "SESSION_ENGINE_UPDATE_REQUIRED"
		}
	} else {
		result.ScreenOnly = reply.ScreenOnly
		if reply.Info != nil {
			result.Name = &reply.Info.Name
		}
		if reply.Lines != nil {
			result.Lines = reply.Lines
		}
	}
	m.emit(result)
}

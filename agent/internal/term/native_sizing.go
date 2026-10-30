package term

import (
	"github.com/podosoft-dev/pdmux/agent/internal/semver"
	"github.com/podosoft-dev/pdmux/agent/internal/session"
)

// sizingEngineVersion is the first engine that sizes a session's screen to the
// viewer in use (the one that last typed into or resized it). Older engines size
// it to the largest viewer, so a narrow pane sharing the session with a wider one
// shows that wider screen cut off at its right edge.
//
// An engine keeps running its sessions after the agent updates (it owns their
// PTYs), so for those engines the agent applies the same rule itself: it reports
// every other viewer of the session no larger than the one in use. The largest
// viewer the old engine picks is then the one in use. A viewer that is not in use
// gets frames no larger than that screen, which is what it would show anyway.
const sizingEngineVersion = "0.1.38"

type nativeSize struct{ cols, rows int }

type nativeResize struct {
	attachment *session.Attachment
	size       nativeSize
}

func legacySizing(a *session.Attachment) bool {
	newer, valid := semver.CompareStrings(sizingEngineVersion, a.Version)
	return !valid || newer > 0
}

// nativeOpened records a new viewer's size and, when its session already has a
// viewer in use on an older engine, reports the new one no larger than that.
func (m *Manager) nativeOpened(a *session.Attachment, cols, rows int) {
	m.mu.Lock()
	size := nativeSize{cols, rows}
	m.nativeSizes[a] = size
	m.nativeSent[a] = size
	var resizes []nativeResize
	if active := m.nativeActive[a.Info.ID]; active != nil && active != a && legacySizing(a) {
		if fit := clampSize(size, m.nativeSizes[active]); fit != size {
			m.nativeSent[a] = fit
			resizes = append(resizes, nativeResize{a, fit})
		}
	}
	m.mu.Unlock()
	sendResizes(resizes)
}

// nativeUse marks the viewer of termID as the one in use after it typed or (with
// size) resized. On an older engine it reports its own size and every other viewer
// of the session no larger than that. It returns whether the caller still has to
// send the viewer's own resize.
func (m *Manager) nativeUse(termID string, size *nativeSize) bool {
	m.mu.Lock()
	a := m.native[termID]
	if a == nil {
		m.mu.Unlock()
		return size != nil
	}
	if size != nil {
		m.nativeSizes[a] = *size
	}
	if !legacySizing(a) {
		if size != nil {
			m.nativeSent[a] = *size
		}
		m.mu.Unlock()
		return size != nil
	}
	m.nativeActive[a.Info.ID] = a
	own := m.nativeSizes[a]
	var resizes []nativeResize
	if m.nativeSent[a] != own || size != nil {
		m.nativeSent[a] = own
		resizes = append(resizes, nativeResize{a, own})
	}
	for _, other := range m.native {
		if other == a || other.Info.ID != a.Info.ID || !legacySizing(other) {
			continue
		}
		if fit := clampSize(m.nativeSizes[other], own); fit != m.nativeSent[other] {
			m.nativeSent[other] = fit
			resizes = append(resizes, nativeResize{other, fit})
		}
	}
	m.mu.Unlock()
	sendResizes(resizes)
	return false
}

// nativeReleased forgets a viewer that closed. When it was the one in use, every
// other viewer of the session gets its own size back, and the engine returns to
// sizing the screen to the largest of them.
func (m *Manager) nativeReleased(a *session.Attachment) {
	m.mu.Lock()
	delete(m.nativeSizes, a)
	delete(m.nativeSent, a)
	var resizes []nativeResize
	if m.nativeActive[a.Info.ID] == a {
		delete(m.nativeActive, a.Info.ID)
		for _, other := range m.native {
			if other.Info.ID != a.Info.ID {
				continue
			}
			if own := m.nativeSizes[other]; m.nativeSent[other] != own {
				m.nativeSent[other] = own
				resizes = append(resizes, nativeResize{other, own})
			}
		}
	}
	m.mu.Unlock()
	sendResizes(resizes)
}

func clampSize(size, limit nativeSize) nativeSize {
	return nativeSize{min(size.cols, limit.cols), min(size.rows, limit.rows)}
}

func sendResizes(resizes []nativeResize) {
	for _, r := range resizes {
		_ = r.attachment.Send(session.Request{Action: "resize", Cols: r.size.cols, Rows: r.size.rows})
	}
}

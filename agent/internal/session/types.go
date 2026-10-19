// Package session owns persistent terminals independently of the network agent.
// Only the local engine holds PTYs; connections are disposable viewers.
package session

import "time"

const (
	Protocol       = 1
	MaxSessions    = 16
	MaxViewers     = 64
	HistoryLines   = 5000
	HistoryBytes   = 8 << 20
	MaxScreenBytes = 256 << 10
	MaxPacketBytes = 16 << 20
	IdleTimeout    = time.Minute
)

// Process is implemented by the existing Unix PTY and Windows ConPTY adapters.
type Process interface {
	Pid() *int
	Write(string) error
	Resize(int, int) error
	Kill()
	Output() <-chan []byte
	Exit() <-chan *int
}

type Factory func(cols, rows int, directory string) (Process, error)

type Info struct {
	Cols     int    `json:"cols"`
	Rows     int    `json:"rows"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	Attached int    `json:"attached"`
	PID      *int   `json:"pid"`
}

// Screen is a rendered viewport, never raw program escape sequences. Queries
// terminate at the engine, so N viewers cannot send N terminal replies.
type Screen struct {
	Data       string `json:"data"`
	Sequence   int    `json:"sequence"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	CanvasCols int    `json:"canvasCols"`
	CanvasRows int    `json:"canvasRows"`
	X          int    `json:"x"`
	Y          int    `json:"y"`
	Follow     bool   `json:"follow"`
}

type Request struct {
	Protocol  int    `json:"protocol"`
	Auth      string `json:"auth,omitempty"`
	Action    string `json:"action"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Directory string `json:"directory,omitempty"`
	Cols      int    `json:"cols,omitempty"`
	Rows      int    `json:"rows,omitempty"`
	Data      string `json:"data,omitempty"`
	X         int    `json:"x,omitempty"`
	Y         int    `json:"y,omitempty"`
	Follow    bool   `json:"follow,omitempty"`
}

type Reply struct {
	Protocol   int      `json:"protocol"`
	Type       string   `json:"type"`
	Error      string   `json:"error,omitempty"`
	Version    string   `json:"version,omitempty"`
	Info       *Info    `json:"info,omitempty"`
	Sessions   []Info   `json:"sessions,omitempty"`
	Screen     *Screen  `json:"screen,omitempty"`
	Lines      []string `json:"lines,omitempty"`
	ScreenOnly bool     `json:"screenOnly,omitempty"`
	Code       *int     `json:"code,omitempty"`
}

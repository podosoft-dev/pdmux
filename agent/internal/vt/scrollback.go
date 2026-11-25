package vt

import (
	"slices"

	uv "github.com/charmbracelet/ultraviolet"
)

// DefaultScrollbackSize is the default maximum number of lines in the scrollback buffer.
const DefaultScrollbackSize = 10000

// Scrollback represents a scrollback buffer that stores lines scrolled off the screen.
type Scrollback struct {
	lines []uv.Line
	// info holds one entry per line: soft wrap, wide-character filler and the
	// width the line was written at (pdmux addition, see lineinfo.go).
	info     []LineInfo
	maxLines int
	// pushed counts every line ever pushed. Unlike Len it keeps growing once
	// the buffer is full, so a reader can tell how many lines arrived.
	pushed uint64
}

// NewScrollback creates a new scrollback buffer with the given maximum number of lines.
func NewScrollback(maxLines int) *Scrollback {
	if maxLines <= 0 {
		maxLines = DefaultScrollbackSize
	}
	return &Scrollback{
		lines:    make([]uv.Line, 0, min(maxLines, 1000)), // Pre-allocate reasonable capacity
		info:     make([]LineInfo, 0, min(maxLines, 1000)),
		maxLines: maxLines,
	}
}

// Push adds a line to the scrollback buffer.
// If the buffer is full, the oldest line is removed.
func (s *Scrollback) Push(line uv.Line) {
	s.push(line, LineInfo{Width: len(line)})
}

// push adds a line with what is known about it.
func (s *Scrollback) push(line uv.Line, info LineInfo) {
	if s == nil || s.maxLines <= 0 {
		return
	}
	if info.Width == 0 {
		info.Width = len(line)
	}

	// Trim trailing empty cells. This helps with wrapping and window
	// resizing. A wide character keeps its placeholder (pdmux change).
	cloned := slices.Clone(line[:trimmedLen(line)])

	if len(s.lines) >= s.maxLines {
		// Remove oldest line and append new one
		s.lines = slices.Delete(s.lines, 0, 1)
		s.info = slices.Delete(s.info, 0, 1)
	}
	s.lines = append(s.lines, cloned)
	s.info = append(s.info, info)
	s.pushed++
}

// Info returns what is known about the line at index (0 is the oldest).
func (s *Scrollback) Info(index int) LineInfo {
	if s == nil || index < 0 || index >= len(s.info) {
		return LineInfo{}
	}
	return s.info[index]
}

// Pushed returns how many lines were ever pushed. The difference across a
// write is the number of lines that write added, even when the buffer was
// full and dropped as many of its oldest lines.
func (s *Scrollback) Pushed() uint64 {
	if s == nil {
		return 0
	}
	return s.pushed
}

// replace installs lines rewrapped by a resize. It does not count as pushing.
func (s *Scrollback) replace(lines []uv.Line, info []LineInfo) {
	s.lines, s.info = lines, info
	if len(s.lines) > s.maxLines {
		drop := len(s.lines) - s.maxLines
		s.lines, s.info = s.lines[drop:], s.info[drop:]
	}
}

// PushN adds n lines from the buffer starting at line y to the scrollback.
func (s *Scrollback) PushN(buf *uv.RenderBuffer, y, n int) {
	if s == nil || buf == nil || n <= 0 {
		return
	}

	for i := range min(n, buf.Height()-y) {
		if line := buf.Line(y + i); line != nil {
			s.Push(line)
		}
	}
}

// Len returns the number of lines in the scrollback buffer.
func (s *Scrollback) Len() int {
	if s == nil {
		return 0
	}
	return len(s.lines)
}

// MaxLines returns the maximum number of lines the scrollback buffer can hold.
func (s *Scrollback) MaxLines() int {
	if s == nil {
		return 0
	}
	return s.maxLines
}

// SetMaxLines sets the maximum number of lines in the scrollback buffer.
// If the current number of lines exceeds the new maximum, oldest lines are removed.
func (s *Scrollback) SetMaxLines(maxLines int) {
	if s == nil || maxLines <= 0 {
		return
	}

	s.maxLines = maxLines
	if len(s.lines) > maxLines {
		// Remove oldest lines
		s.lines = s.lines[len(s.lines)-maxLines:]
		s.info = s.info[len(s.info)-maxLines:]
	}
}

// Line returns the line at the given index.
// Index 0 is the oldest line, Len()-1 is the most recent.
// Returns nil if index is out of bounds.
func (s *Scrollback) Line(index int) uv.Line {
	if s == nil || index < 0 || index >= len(s.lines) {
		return nil
	}
	return s.lines[index]
}

// Lines returns all lines in the scrollback buffer.
// Index 0 is the oldest line.
func (s *Scrollback) Lines() []uv.Line {
	if s == nil {
		return nil
	}
	return s.lines
}

// Clear removes all lines from the scrollback buffer.
func (s *Scrollback) Clear() {
	if s == nil {
		return
	}
	s.lines = s.lines[:0]
	s.info = s.info[:0]
}

// CellAt returns the cell at the given position in the scrollback buffer.
// x is the column, y is the line index (0 = oldest).
// Returns nil if position is out of bounds.
func (s *Scrollback) CellAt(x, y int) *uv.Cell {
	line := s.Line(y)
	if line == nil || x < 0 || x >= len(line) {
		return nil
	}
	return &line[x]
}

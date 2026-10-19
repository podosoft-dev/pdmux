package term

import (
	"io"
	"time"
)

// Window bounds. The contract already caps a terminal at 1000x500, and the
// ioctl takes uint16 — an out-of-range value would WRAP (65616 columns becomes
// 80) and hand the shell a size nobody asked for, so the value is clamped
// rather than converted. Terminal frames skip schema validation on arrival, so
// this is the layer that has to hold.
const (
	maxCols = 1000
	maxRows = 500
)

const (
	// readChunkBytes is one read(2) from the master. Big enough that a build log
	// is a handful of syscalls, small enough that a chatty pane does not hold a
	// megabyte per terminal.
	readChunkBytes = 32 << 10
	// outputQueueDepth lets the reader stay ahead of a consumer that is busy
	// framing. Past it the reader blocks, which is correct: the backpressure ends
	// at the kernel's pty buffer, and the manager's own cap is what decides which
	// bytes survive.
	outputQueueDepth = 64
	// killGrace is how long a terminated child has before SIGKILL.
	killGrace = 2 * time.Second
	// drainGrace is how long the reader gets to finish after the child exits.
	// Closing the master the instant Wait returns would cut off whatever the child
	// wrote last — which, for a command that just failed, is the only part anyone
	// wants to read.
	drainGrace = 250 * time.Millisecond
)

// Spec is what to run and how big its window starts.
type Spec struct {
	File string
	Args []string
	Cols int
	Rows int
	// Dir is the working directory; empty means the user's home.
	Dir string
	// Env replaces the environment when non-nil. Nil means the agent's own
	// environment without its control variables (sys.AgentEnv), with TERM and an
	// encoding set on unix, which is what every current caller wants.
	Env []string
}

// Process is one live pseudo-terminal.
//
// ⚠ ORDERING CONTRACT: Output is closed BEFORE Exit delivers. A consumer that
// has seen a value on Exit can therefore drain Output to completion and know it
// holds every byte the child wrote. Without that rule the last screen of a
// command races the exit frame and loses, which reads as "the terminal ate my
// error message".
//
// A consumer must keep draining Output for the terminal's whole life; the
// producer blocks once the queue fills. Every chunk belongs to the consumer —
// an implementation that recycled its read buffer would rewrite bytes already
// sitting in a pane's flush queue.
type Process interface {
	// Pid is the child's process id, or nil when there is none to report. It goes
	// straight into the `ready` frame, where the contract's type is nullable.
	Pid() *int
	Write(data string) error
	Resize(cols, rows int) error
	// Kill ends the process GROUP, not just the child — see the implementation.
	Kill()
	Output() <-chan []byte
	// Exit delivers exactly one status and is then closed. A nil value means the
	// child was killed by a signal, which the contract renders as `null` rather
	// than as an exit code of 0.
	Exit() <-chan *int
}

// clampWindow converts a requested size into the ioctl's uint16 without ever
// wrapping. See maxCols/maxRows.
func clampWindow(cols, rows int) (uint16, uint16) {
	return clampDimension(cols, maxCols), clampDimension(rows, maxRows)
}

func clampDimension(value, max int) uint16 {
	if value < 1 {
		return 1
	}
	if value > max {
		return uint16(max)
	}
	return uint16(value)
}

// splitRune divides p into the bytes that are safe to emit now and the trailing
// bytes of an incomplete UTF-8 sequence, which belong to the next read.
func splitRune(p []byte) (complete, partial []byte) {
	// A sequence is at most 4 bytes, so only the last 3 can be incomplete.
	for i := len(p) - 1; i >= 0 && i >= len(p)-3; i-- {
		b := p[i]
		if b < 0x80 {
			return p, nil // ASCII: nothing can be pending behind it.
		}
		if b&0xC0 == 0xC0 { // a start byte
			need := runeLen(b)
			if need > 0 && len(p)-i < need {
				return p[:i], p[i:]
			}
			return p, nil
		}
		// A continuation byte: keep walking back to find its start byte.
	}
	return p, nil
}

func runeLen(start byte) int {
	switch {
	case start&0xE0 == 0xC0:
		return 2
	case start&0xF0 == 0xE0:
		return 3
	case start&0xF8 == 0xF0:
		return 4
	default:
		return 0 // Not a legal start byte; emit it and let the decoder complain.
	}
}

func pumpOutput(reader io.Reader, output chan<- []byte, done chan<- struct{}) {
	defer close(done)
	defer close(output)

	buf := make([]byte, readChunkBytes)
	var partial []byte
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if len(partial) > 0 {
				chunk = append(partial, chunk...)
				partial = nil
			}
			// A UTF-8 sequence split across two reads must not be emitted in
			// halves: each half becomes U+FFFD the moment the frame is JSON
			// encoded, so one Korean character typed at a prompt would come back
			// as two permanent replacement characters. Hold the tail instead.
			complete, rest := splitRune(chunk)
			if len(rest) > 0 {
				partial = append([]byte(nil), rest...)
			}
			if len(complete) > 0 {
				out := make([]byte, len(complete))
				copy(out, complete)
				output <- out
			}
		}
		if err != nil {
			// EIO from a pty master is how the kernel says "the last slave closed",
			// i.e. the child exited. It is the ordinary end of every terminal, not a
			// failure to report. Whatever partial sequence is left is emitted
			// as-is: the child is gone, so the rest of that rune is never coming.
			if len(partial) > 0 {
				output <- partial
			}
			return
		}
	}
}

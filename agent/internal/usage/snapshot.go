package usage

// Provider #1 — a statusline/OAuth-usage snapshot file on disk.
//
// WHY A FILE: one popular coding CLI exposes its rate limits ONLY inside the
// JSON payload it hands to a user-supplied statusline command. There is no
// `usage` subcommand and nothing on disk caches the bars, so the integration is
// a small wrapper that tees that payload into a snapshot file which this
// provider reads. The agent therefore never has to run the CLI or hold its
// credentials.
//
// Shape (both polarities stored, keys named by window length):
//
//	{"ts":1784982799,
//	 "five_hour":{"used_pct":3,"remaining_pct":97,"resets_at":1784983800},
//	 "seven_day":null}
//
// Ported from apps/agent/src/usage/snapshot-file.ts.

import (
	"context"
	"encoding/json"
	"os"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// snapshotKeys maps a snapshot key onto a protocol window key, NAMED BY LENGTH
// rather than by position.
//
// It is an ordered slice and not a map because Go randomises map iteration: the
// window order would then change from pass to pass and the card's bars would
// swap places while nothing about the account had moved.
var snapshotKeys = []struct{ source, window string }{
	{"five_hour", WindowSession},
	{"session", WindowSession},
	{"seven_day", WindowWeekly},
	{"weekly", WindowWeekly},
}

// ParseSnapshotWindows turns a decoded snapshot document into raw windows.
// Unknown keys are ignored, so a wrapper may write whatever else it likes
// alongside them.
func ParseSnapshotWindows(document any) []RawWindow {
	record, ok := document.(map[string]any)
	if !ok {
		return nil
	}
	out := []RawWindow{}
	for _, mapping := range snapshotKeys {
		// A key that is absent, null, or not an object describes a window the CLI
		// does not have — `seven_day: null` is the documented way to say so.
		entry, ok := record[mapping.source].(map[string]any)
		if !ok {
			continue
		}
		out = append(out, RawWindow{
			Key:          mapping.window,
			UsedPct:      numAt(entry, "used_pct", "usedPct"),
			RemainingPct: numAt(entry, "remaining_pct", "remainingPct"),
			ResetsAt:     numAt(entry, "resets_at", "resetsAt"),
		})
	}
	return out
}

// ReadFileFunc reads a whole file. ok is false when it is missing or unreadable,
// which for a snapshot means "the CLI is not installed or never ran" — a fact,
// not an error to report.
type ReadFileFunc func(path string) (string, bool)

// SnapshotFileOptions configures one snapshot-file provider.
type SnapshotFileOptions struct {
	ID string
	// Path is the absolute path of the snapshot file.
	Path string
	// Fallbacks are read, in order, when Path is missing.
	//
	// WHY MORE THAN ONE PATH: this agent does not write the snapshot — a statusline
	// wrapper the operator installs does, and that wrapper long outlives any one
	// deployment's idea of where the file goes. Measured here: a wrapper left over from
	// the predecessor tool was writing a perfectly-shaped snapshot every few seconds
	// into `~/.claude/dev-ws-usage.json` while this agent read `~/.claude/pdmux-usage.json`
	// and reported nothing. Nobody was wrong; the two just never agreed on a name.
	// Reading a short list of known names costs one `stat` per miss and makes the
	// common case — an operator who already had a working wrapper — simply work.
	Fallbacks []string
	// ProcessName defaults to ID — a provider is identified by its binary name.
	ProcessName string
	ReadFile    ReadFileFunc
	Now         func() int64
	ProcDir     string
}

// SnapshotFileProvider reads one snapshot file and counts one process name.
type SnapshotFileProvider struct {
	id          string
	path        string
	fallbacks   []string
	processName string
	read        ReadFileFunc
	now         func() int64
	procDir     string
}

// NewSnapshotFileProvider builds a provider, filling in the host defaults for
// anything omitted.
func NewSnapshotFileProvider(options SnapshotFileOptions) *SnapshotFileProvider {
	provider := &SnapshotFileProvider{
		id:          options.ID,
		path:        options.Path,
		fallbacks:   options.Fallbacks,
		processName: options.ProcessName,
		read:        options.ReadFile,
		now:         options.Now,
		procDir:     options.ProcDir,
	}
	if provider.processName == "" {
		provider.processName = options.ID
	}
	if provider.read == nil {
		provider.read = ReadTextFile
	}
	if provider.now == nil {
		provider.now = nowSeconds
	}
	return provider
}

// ID is the provider id, echoed to the server as-is.
func (p *SnapshotFileProvider) ID() string { return p.id }

// ProcessCount counts live processes of the CLI by exact name.
func (p *SnapshotFileProvider) ProcessCount(ctx context.Context) int {
	return CountProcesses(ctx, p.processName, ProcessCountOptions{ProcDir: p.procDir})
}

// Paths are the snapshot locations this provider will read, in order.
func (p *SnapshotFileProvider) Paths() []string {
	return append([]string{p.path}, p.fallbacks...)
}

// Windows reads the snapshot and normalises it.
//
// The first path that yields a readable file wins; a fallback is consulted only when the
// preferred one is absent, so moving a wrapper to the canonical name always takes effect
// immediately rather than being shadowed by a stale legacy file.
func (p *SnapshotFileProvider) Windows(ctx context.Context) []protocol.UsageWindow {
	empty := []protocol.UsageWindow{}
	var text string
	var ok bool
	for _, candidate := range p.Paths() {
		if candidate == "" {
			continue
		}
		if text, ok = p.read(candidate); ok {
			break
		}
	}
	// No file anywhere = the CLI is not installed, never ran, or has no wrapper. No
	// rows, no zeros.
	if !ok {
		return empty
	}
	var document any
	if err := json.Unmarshal([]byte(text), &document); err != nil {
		// A half-written file: the wrapper rewrites this snapshot while we read it,
		// so a truncated document is an ordinary race and the next pass gets it.
		return empty
	}
	return NormalizeWindows(ParseSnapshotWindows(document), p.now())
}

// ReadTextFile is the default ReadFileFunc.
func ReadTextFile(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

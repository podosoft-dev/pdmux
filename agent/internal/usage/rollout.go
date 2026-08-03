package usage

// Provider #3 — the session transcript one CLI already writes to disk.
//
// WHY IT EXISTS: the provider it replaces spawned the CLI on every pass, and the
// CLI is a node launcher that execs a 259 MB native binary. Measured on a host
// with a 60-second interval, one pass cost:
//
//	node launcher   ~48 MiB RSS   ~0.12 s CPU
//	native binary   ~86 MiB RSS   ~0.16 s CPU
//	                ------------------------
//	                ~134 MiB      ~0.28 s     every 60 s
//
// The agent's own steady state on that host was 24 MiB and 0.36% CPU, so asking
// the question cost MORE than everything else the agent did — and it did so on a
// machine whose whole point is running someone else's work.
//
// ⚠ AND THE ANSWER WAS ALREADY ON DISK. The same CLI appends its rate-limit
// snapshot to the session transcript it writes anyway, in the same shape the RPC
// returns (`primary`/`secondary`, `used_percent`, `window_minutes`, `resets_at`).
// Reading the tail of one file gets the identical numbers for no process, no
// credentials and a bounded read.
//
// WHAT THIS COSTS INSTEAD: one directory listing per level of a `YYYY/MM/DD`
// tree, walked newest-first, plus a read of the last TailBytes of one file. It
// never reads a transcript whole — they reach tens of megabytes within a day.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// TailBytes is how much of the transcript's end is read.
//
// Sized against the thing it must not miss: transcripts interleave rate-limit
// events with model output, and a single assistant turn can be tens of KiB. 256
// KiB spans many turns on the measured host while staying a cheap read on a file
// that is already in the page cache.
const TailBytes = 256 << 10

// RolloutFileOptions configures the transcript provider.
type RolloutFileOptions struct {
	ID string
	// Root is the directory holding the `YYYY/MM/DD` transcript tree.
	Root string
	// ProcessName defaults to ID.
	ProcessName string
	// ReadTail is a test seam: return the tail of a file's contents.
	ReadTail func(path string) (string, bool)
	// FindNewest is a test seam: return the transcript to read.
	FindNewest func(root string) (string, bool)
	Now        func() int64
	ProcDir    string
}

// RolloutFileProvider reads the newest session transcript's last rate-limit event.
type RolloutFileProvider struct {
	id          string
	root        string
	processName string
	readTail    func(path string) (string, bool)
	findNewest  func(root string) (string, bool)
	now         func() int64
	procDir     string
}

// NewRolloutFileProvider builds a provider, filling in the host defaults.
func NewRolloutFileProvider(options RolloutFileOptions) *RolloutFileProvider {
	provider := &RolloutFileProvider{
		id:          options.ID,
		root:        options.Root,
		processName: options.ProcessName,
		readTail:    options.ReadTail,
		findNewest:  options.FindNewest,
		now:         options.Now,
		procDir:     options.ProcDir,
	}
	if provider.processName == "" {
		provider.processName = options.ID
	}
	if provider.readTail == nil {
		provider.readTail = ReadFileTail
	}
	if provider.findNewest == nil {
		provider.findNewest = NewestTranscript
	}
	if provider.now == nil {
		provider.now = nowSeconds
	}
	return provider
}

// ID is the provider id, echoed to the server as-is.
func (p *RolloutFileProvider) ID() string { return p.id }

// ProcessCount counts live processes of the CLI by exact name.
func (p *RolloutFileProvider) ProcessCount(ctx context.Context) int {
	return CountProcesses(ctx, p.processName, ProcessCountOptions{ProcDir: p.procDir})
}

// Paths reports where this provider looks, for the "running but silent" log line.
func (p *RolloutFileProvider) Paths() []string { return []string{p.root} }

// Windows returns the newest rate-limit snapshot in the newest transcript.
func (p *RolloutFileProvider) Windows(ctx context.Context) []protocol.UsageWindow {
	empty := []protocol.UsageWindow{}
	if p.root == "" {
		return empty
	}
	path, ok := p.findNewest(p.root)
	if !ok {
		// No transcript = the CLI has never run here. A fact, not an error.
		return empty
	}
	tail, ok := p.readTail(path)
	if !ok {
		return empty
	}
	limits, ok := LastRateLimitsInTail(tail)
	if !ok {
		return empty
	}
	// Wrapped in the key the RPC result used, so the two paths share one mapper
	// and cannot drift on which slot means which window.
	return NormalizeWindows(WindowsFromRPCResult(map[string]any{"rateLimits": limits}), p.now())
}

// LastRateLimitsInTail finds the newest `rate_limits` object in a transcript tail.
//
// Scanned BACKWARDS and stopped at the first hit: the newest event is the answer
// and a transcript holds thousands of them, so parsing forwards would decode the
// whole tail to throw all but one away.
//
// ⚠ THE FIRST LINE IS SKIPPED. A tail starts mid-file, so its first line is
// almost always a fragment — and a fragment that happens to parse is worse than
// one that does not.
func LastRateLimitsInTail(tail string) (map[string]any, bool) {
	lines := strings.Split(tail, "\n")
	for i := len(lines) - 1; i >= 1; i-- {
		line := strings.TrimSpace(lines[i])
		// Cheap reject before the decoder: the overwhelming majority of lines are
		// model output and never mention this at all.
		if line == "" || !strings.Contains(line, `"rate_limits"`) {
			continue
		}
		var document any
		if err := json.Unmarshal([]byte(line), &document); err != nil {
			continue
		}
		if limits, ok := findRateLimits(document); ok {
			return limits, true
		}
	}
	return nil, false
}

// findRateLimits walks a decoded record for the first `rate_limits` object.
//
// The key is nested inside an event envelope whose shape is the CLI's business
// and has changed before. Searching for the field rather than a path means a
// re-nesting upstream does not silently return "no budget".
func findRateLimits(node any) (map[string]any, bool) {
	switch value := node.(type) {
	case map[string]any:
		if limits, ok := value["rate_limits"].(map[string]any); ok {
			return limits, true
		}
		// Sorted so a document with more than one match resolves the same way every
		// pass; Go randomises map iteration and the card would otherwise flicker
		// between two answers.
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			if found, ok := findRateLimits(value[key]); ok {
				return found, true
			}
		}
	case []any:
		for _, item := range value {
			if found, ok := findRateLimits(item); ok {
				return found, true
			}
		}
	}
	return nil, false
}

// NewestTranscript finds the most recent `rollout-*.jsonl` under a `YYYY/MM/DD` root.
//
// ⚠ IT DESCENDS ONE BRANCH, NOT THE TREE. A year of transcripts is thousands of
// files across hundreds of directories, and walking them every minute would trade
// one expensive process for one expensive filesystem scan. Names are zero-padded,
// so the newest branch is the lexicographically last one at each level.
func NewestTranscript(root string) (string, bool) {
	dir := root
	for depth := 0; depth < 3; depth++ {
		next, ok := lastEntry(dir, true)
		if !ok {
			break
		}
		dir = next
	}
	// mtime, not name: a transcript is appended to for as long as its session
	// lives, so yesterday's file can be newer than one started this morning.
	newest, ok := newestFileByModTime(dir, "rollout-", ".jsonl")
	if ok {
		return newest, true
	}
	// A tree shallower or deeper than expected still answers, at the cost of one
	// listing of the root.
	return newestFileByModTime(root, "rollout-", ".jsonl")
}

func lastEntry(dir string, wantDir bool) (string, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() == wantDir && !strings.HasPrefix(entry.Name(), ".") {
			names = append(names, entry.Name())
		}
	}
	if len(names) == 0 {
		return "", false
	}
	sort.Strings(names)
	return filepath.Join(dir, names[len(names)-1]), true
}

func newestFileByModTime(dir, prefix, suffix string) (string, bool) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", false
	}
	best := ""
	var bestAt int64
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasPrefix(name, prefix) || !strings.HasSuffix(name, suffix) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if at := info.ModTime().UnixNano(); best == "" || at > bestAt {
			best, bestAt = filepath.Join(dir, name), at
		}
	}
	return best, best != ""
}

// ReadFileTail reads at most TailBytes from the end of a file.
//
// Seeked rather than read-and-slice: these files reach tens of megabytes, and
// reading one whole every pass would replace a process spawn with an allocation
// just as unwelcome on someone else's machine.
func ReadFileTail(path string) (string, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return "", false
	}
	size := info.Size()
	offset := int64(0)
	if size > TailBytes {
		offset = size - TailBytes
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return "", false
	}
	data, err := io.ReadAll(io.LimitReader(file, TailBytes))
	if err != nil {
		return "", false
	}
	// A transcript is appended to while it is read, so the last line is routinely
	// half-written. Dropping the trailing fragment costs one pass at most.
	if index := bytes.LastIndexByte(data, '\n'); index >= 0 {
		data = data[:index]
	}
	return string(data), true
}

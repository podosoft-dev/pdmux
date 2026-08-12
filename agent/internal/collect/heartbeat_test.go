package collect

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// quietReaders measure nothing and touch no host: every field comes back nil,
// which is what a pass on a machine with no /proc and no df legitimately looks
// like. Using them keeps a heartbeat spec independent of the runner's own load.
func quietReaders() ResourceReaders {
	return ResourceReaders{
		CPU: NewCPUMeter(CPUMeterOptions{
			ReadStat:  func() (string, bool) { return "", false },
			Load:      func() (float64, bool) { return 0, false },
			CoreCount: 1,
		}),
		Memory:    func() *MemoryReading { return nil },
		Swap:      func() *SwapReading { return nil },
		Disk:      func(context.Context) *DiskReading { return nil },
		Load:      func() (float64, bool) { return 0, false },
		UptimeSec: func() (int64, bool) { return 0, false },
	}
}

// stubUsage is the usage track's seam, without the usage track.
type stubUsage struct {
	rows        []protocol.AgentUsage
	unavailable []string
	panics      bool
}

func (s *stubUsage) Collect(context.Context) []protocol.AgentUsage {
	if s.panics {
		panic("usage exploded")
	}
	return s.rows
}

func (s *stubUsage) Unavailable() []string { return s.unavailable }

func TestHeartbeat(t *testing.T) {
	t.Run("[TC-PDAGENT-029] still ships a heartbeat when a collector fails", func(t *testing.T) {
		lines := &sync.Map{}
		logger := log.New(log.Options{Sink: func(line string) { lines.Store(line, true) }})

		readers := quietReaders()
		readers.Memory = func() *MemoryReading { panic("meminfo exploded") }
		readers.Disk = func(context.Context) *DiskReading { panic("df hung") }

		got := Heartbeat(t.Context(), testConfig(nil, nil), Deps{
			Resource: readers,
			Sessions: func(context.Context) SessionReading { panic("tmux exploded") },
			Usage:    &stubUsage{panics: true},
			Now:      func() int64 { return 1_785_000_000 },
			Log:      logger,
		})

		// Silence is the failure mode this guards: an agent that skipped the beat
		// would be indistinguishable from a host that went down.
		if got.Ts != 1_785_000_000 {
			t.Fatalf("ts = %d, want the pass to have completed", got.Ts)
		}
		if len(got.Sessions) != 0 || got.Sessions == nil {
			t.Fatalf("sessions = %v, want an empty list", got.Sessions)
		}
		if got.Resource.MemPct != nil || got.Resource.DiskPct != nil {
			t.Fatalf("resource = %+v, want nil for what could not be measured", got.Resource)
		}
		if len(got.Usage) != 0 || got.Usage == nil {
			t.Fatalf("usage = %v, want an empty list", got.Usage)
		}

		// Unlike the TypeScript's silent `.catch`, a panic says so once: in Go it
		// means a bug, and a swallowed one costs an afternoon.
		found := false
		lines.Range(func(key, _ any) bool {
			if strings.Contains(key.(string), "collector failed") {
				found = true
			}
			return !found
		})
		if !found {
			t.Fatal("a panicking collector was swallowed without a log line")
		}
	})

	t.Run("[TC-PDAGENT-029] a failed session read does not claim the multiplexer is missing", func(t *testing.T) {
		p := newProbes(false, true)
		got := Heartbeat(t.Context(), testConfig(nil, nil), Deps{
			Resource:    quietReaders(),
			Sessions:    func(context.Context) SessionReading { panic("tmux exploded") },
			Diagnostics: p.collector,
			Now:         func() int64 { return 1_785_000_000 },
		})
		// `mux.missing` is a claim about the host, and a timeout is no evidence
		// for it — a badge that appears whenever tmux is slow is a badge nobody
		// believes.
		if slices.Contains(codesOf(got.Diagnostics), CodeMuxMissing) {
			t.Fatalf("diagnostics = %v, want no mux.missing", codesOf(got.Diagnostics))
		}
	})

	t.Run("[TC-PDAGENT-029] a panicking service probe costs its own result only", func(t *testing.T) {
		service := protocol.NewAgentServiceConfig()
		service.ID = probeServiceID
		service.Port = listeningPort(t)
		config := testConfig(nil, nil)
		config.Services = []protocol.AgentServiceConfig{service}
		config.ProbeTimeoutMs = 500

		got := Heartbeat(t.Context(), config, Deps{
			Resource: quietReaders(),
			Sessions: func(context.Context) SessionReading { return SessionReading{Present: true} },
			Now:      func() int64 { return 1_785_000_000 },
		})
		if len(got.Services) != 1 || got.Services[0].ID != probeServiceID {
			t.Fatalf("services = %+v, want one row per configured service", got.Services)
		}
	})

	// No TC: this is the contract-level invariant from protocol/types.go (a nil
	// slice marshals to null and the server rejects the frame), asserted where
	// the frame is built rather than only where it is sent.
	t.Run("encodes as a frame the contract accepts, with no nil slice in it", func(t *testing.T) {
		got := Heartbeat(t.Context(), testConfig(nil, nil), Deps{
			Resource: quietReaders(),
			// A collector that hands back a nil slice is the trap: the value is
			// legal Go and illegal JSON.
			Sessions: func(context.Context) SessionReading { return SessionReading{Sessions: nil, Present: true} },
			Usage:    &stubUsage{rows: nil},
			Now:      func() int64 { return 1_785_000_000 },
		})

		raw, err := protocol.EncodeUpstream(&protocol.HeartbeatFrame{Heartbeat: got})
		if err != nil {
			t.Fatalf("heartbeat rejected by the contract: %v", err)
		}
		for _, key := range []string{"sessions", "usage", "services", "diagnostics"} {
			if strings.Contains(string(raw), `"`+key+`":null`) {
				t.Fatalf("%s marshalled as null: %s", key, raw)
			}
		}
		// Every unmeasured value IS null, which is the opposite requirement and
		// the reason the two are worth asserting together.
		var decoded map[string]any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			t.Fatalf("unmarshalling the frame: %v", err)
		}
		resource, _ := decoded["heartbeat"].(map[string]any)["resource"].(map[string]any)
		for _, key := range []string{
			"cpuPct", "memPct", "diskPct",
			"swapPct", "swapUsedBytes", "swapTotalBytes",
			"load1", "uptimeSec",
		} {
			value, present := resource[key]
			if !present || value != nil {
				t.Fatalf("resource.%s = %v, want an explicit null", key, value)
			}
		}
	})

	// No TC: NewDeps is the wiring the daemon uses, and the CPU meter it builds
	// has to survive across passes or CPU is nil forever.
	t.Run("keeps one cpu meter across passes", func(t *testing.T) {
		deps := NewDeps(nil)
		if deps.Resource.CPU == nil {
			t.Fatal("NewDeps built no cpu meter")
		}
		samples := []string{statA, statB}
		index := 0
		deps.Resource.CPU = NewCPUMeter(CPUMeterOptions{ReadStat: func() (string, bool) {
			text := samples[min(index, len(samples)-1)]
			index++
			return text, true
		}})
		deps.Resource.Memory = func() *MemoryReading { return nil }
		deps.Resource.Disk = func(context.Context) *DiskReading { return nil }
		deps.Resource.Load = func() (float64, bool) { return 0, false }
		deps.Resource.UptimeSec = func() (int64, bool) { return 0, false }
		deps.Sessions = func(context.Context) SessionReading { return SessionReading{Present: true} }

		if first := Heartbeat(t.Context(), testConfig(nil, nil), deps); first.Resource.CPUPct != nil {
			t.Fatalf("first pass reported %d, want nil", *first.Resource.CPUPct)
		}
		second := Heartbeat(t.Context(), testConfig(nil, nil), deps)
		if second.Resource.CPUPct == nil || *second.Resource.CPUPct != 25 {
			t.Fatalf("second pass reported %v, want 25", second.Resource.CPUPct)
		}
	})
}

// TestSlowCollectorIsNamed pins the per-collector timing line.
//
// ⚠ THE PASS-LEVEL WARNING CANNOT NAME THE CULPRIT — the collectors run in
// parallel, so "Slow pass" only ever reports the maximum, and one field round
// chased four innocent collectors before this line existed. Lower the threshold
// seam, make one collector dawdle, and the line must say which.
func TestSlowCollectorIsNamed(t *testing.T) {
	previous := slowCollectorThreshold
	slowCollectorThreshold = time.Millisecond
	t.Cleanup(func() { slowCollectorThreshold = previous })

	var mu sync.Mutex
	var lines []string
	logger := log.New(log.Options{Level: log.LevelDebug, Sink: func(line string) {
		mu.Lock()
		lines = append(lines, line)
		mu.Unlock()
	}})

	deps := Deps{
		Sessions: func(ctx context.Context) SessionReading {
			time.Sleep(5 * time.Millisecond)
			return SessionReading{Sessions: []protocol.MuxSession{}, Present: true}
		},
		Log: logger,
	}
	Heartbeat(context.Background(), protocol.NewAgentConfig(), deps)

	mu.Lock()
	defer mu.Unlock()
	for _, line := range lines {
		if strings.Contains(line, "Slow collector") && strings.Contains(line, "collector=sessions") {
			return
		}
	}
	t.Fatalf("a collector dawdled past the threshold and no line named it; lines=%q", lines)
}

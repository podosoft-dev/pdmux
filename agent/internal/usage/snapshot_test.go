package usage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func snapshotJSON(t *testing.T, document any) string {
	t.Helper()
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encoding snapshot: %v", err)
	}
	return string(encoded)
}

func TestSnapshotFileProvider(t *testing.T) {
	// The documented shape: both polarities, keys named by window LENGTH, and a
	// window the account does not have written as null.
	snapshot := func(t *testing.T) string {
		return snapshotJSON(t, map[string]any{
			"ts":        testNow,
			"five_hour": map[string]any{"used_pct": 3, "remaining_pct": 97, "resets_at": testNow + 1_800},
			"seven_day": map[string]any{"used_pct": 60, "remaining_pct": 40, "resets_at": testNow - 10},
			"weekly":    nil,
		})
	}

	t.Run("[TC-PDAGENT-018] maps snapshot keys to window keys and drops the expired one", func(t *testing.T) {
		text := snapshot(t)
		provider := NewSnapshotFileProvider(SnapshotFileOptions{
			ID:       "claude",
			Path:     "/snap.json",
			ReadFile: func(string) (string, bool) { return text, true },
			Now:      func() int64 { return testNow },
		})
		got := provider.Windows(t.Context())
		if len(got) != 1 {
			t.Fatalf("windows = %+v, want only the live session window", got)
		}
		if got[0].Key != WindowSession {
			t.Fatalf("key = %q, want %q", got[0].Key, WindowSession)
		}
		if used := mustInt(t, got[0].UsedPct, "usedPct"); used != 3 {
			t.Fatalf("usedPct = %d, want 3", used)
		}
		if remaining := mustInt(t, got[0].RemainingPct, "remainingPct"); remaining != 97 {
			t.Fatalf("remainingPct = %d, want 97", remaining)
		}
		if got[0].ResetsAt == nil || *got[0].ResetsAt != testNow+1_800 {
			t.Fatalf("resetsAt = %v, want %d", got[0].ResetsAt, testNow+1_800)
		}
	})

	t.Run("[TC-PDAGENT-018] reports nothing when the snapshot file is absent", func(t *testing.T) {
		// No file = the CLI is not installed or never ran. No rows, no zeros.
		provider := NewSnapshotFileProvider(SnapshotFileOptions{
			ID:       "claude",
			Path:     "/snap.json",
			ReadFile: func(string) (string, bool) { return "", false },
			Now:      func() int64 { return testNow },
		})
		got := provider.Windows(t.Context())
		if got == nil {
			t.Fatal("windows = nil, want an empty (non-nil) list")
		}
		if len(got) != 0 {
			t.Fatalf("windows = %+v, want none", got)
		}
	})

	t.Run("[TC-PDAGENT-018] survives a truncated (half-written) snapshot", func(t *testing.T) {
		// The wrapper rewrites this file while we read it; a torn read is ordinary.
		provider := NewSnapshotFileProvider(SnapshotFileOptions{
			ID:       "claude",
			Path:     "/snap.json",
			ReadFile: func(string) (string, bool) { return `{"ts":178500`, true },
			Now:      func() int64 { return testNow },
		})
		if got := provider.Windows(t.Context()); len(got) != 0 {
			t.Fatalf("windows = %+v, want none", got)
		}
	})

	t.Run("reads camelCase spellings and ignores keys it does not know", func(t *testing.T) {
		text := snapshotJSON(t, map[string]any{
			"session":  map[string]any{"usedPct": 25, "resetsAt": testNow + 60},
			"monthly":  map[string]any{"used_pct": 10, "resets_at": testNow + 60},
			"whatever": "not an object",
		})
		provider := NewSnapshotFileProvider(SnapshotFileOptions{
			ID:       "acme",
			Path:     "/snap.json",
			ReadFile: func(string) (string, bool) { return text, true },
			Now:      func() int64 { return testNow },
		})
		got := provider.Windows(t.Context())
		if len(got) != 1 || got[0].Key != WindowSession {
			t.Fatalf("windows = %+v, want only the session window", got)
		}
		if used := mustInt(t, got[0].UsedPct, "usedPct"); used != 25 {
			t.Fatalf("usedPct = %d, want 25", used)
		}
	})

	t.Run("orders windows the same way on every pass", func(t *testing.T) {
		// Go randomises map iteration; bars that swap places between passes read as
		// flapping even when nothing about the account moved.
		text := snapshotJSON(t, map[string]any{
			"weekly":    map[string]any{"used_pct": 40, "resets_at": testNow + 86_400},
			"five_hour": map[string]any{"used_pct": 10, "resets_at": testNow + 600},
		})
		provider := NewSnapshotFileProvider(SnapshotFileOptions{
			ID:       "claude",
			Path:     "/snap.json",
			ReadFile: func(string) (string, bool) { return text, true },
			Now:      func() int64 { return testNow },
		})
		for pass := range 20 {
			got := provider.Windows(t.Context())
			if len(got) != 2 {
				t.Fatalf("pass %d: windows = %+v, want two", pass, got)
			}
			if got[0].Key != WindowSession || got[1].Key != WindowWeekly {
				t.Fatalf("pass %d: order = %q,%q", pass, got[0].Key, got[1].Key)
			}
		}
	})

	t.Run("reads the real file when no seam is injected", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "pdmux-usage.json")
		body := fmt.Sprintf(`{"five_hour":{"used_pct":50,"resets_at":%d}}`, testNow+60)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatalf("writing snapshot: %v", err)
		}
		provider := NewSnapshotFileProvider(SnapshotFileOptions{
			ID: "claude", Path: path, Now: func() int64 { return testNow },
		})
		got := provider.Windows(t.Context())
		if len(got) != 1 || mustInt(t, got[0].RemainingPct, "remainingPct") != 50 {
			t.Fatalf("windows = %+v, want one window with 50%% left", got)
		}
	})
}

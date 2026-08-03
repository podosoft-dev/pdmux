package usage

import (
	"path/filepath"
	"strconv"
	"testing"
)

func TestRegistry(t *testing.T) {
	t.Run("[TC-PDAGENT-020] gives an unknown provider a generic snapshot path", func(t *testing.T) {
		// This is what makes a new CLI an integration rather than a release: a
		// wrapper writes one small JSON file and the agent already reads it.
		want := filepath.Join("/home/dev", ".config", "pdmux", "usage", "acme-cli.json")
		provider := NewProvider("acme-cli", RegistryOptions{
			Home: "/home/dev",
			ReadFile: func(path string) (string, bool) {
				if path != want {
					return "", false
				}
				return `{"session":{"used_pct":25,"resets_at":` + strconv.FormatInt(testNow+60, 10) + `}}`, true
			},
			Now: fixedClock(testNow),
		})
		got := provider.Windows(t.Context())
		if len(got) != 1 || got[0].Key != WindowSession {
			t.Fatalf("windows = %+v, want one session window read from %s", got, want)
		}
		if used := mustInt(t, got[0].UsedPct, "usedPct"); used != 25 {
			t.Fatalf("usedPct = %d, want 25", used)
		}
		if remaining := mustInt(t, got[0].RemainingPct, "remainingPct"); remaining != 75 {
			t.Fatalf("remainingPct = %d, want 75", remaining)
		}
	})

	t.Run("picks the adapter that matches how each CLI reports", func(t *testing.T) {
		// The only file in the agent allowed to know a vendor exists — and it knows
		// two, because they cover the two shapes seen in the wild.
		asked := []string{}
		claude := NewProvider("claude", RegistryOptions{
			Home:     "/home/dev",
			ReadFile: func(path string) (string, bool) { asked = append(asked, path); return "", false },
			Now:      fixedClock(testNow),
		})
		if _, ok := claude.(*SnapshotFileProvider); !ok {
			t.Fatalf("claude = %T, want a snapshot-file provider", claude)
		}
		claude.Windows(t.Context())
		// The canonical name is asked FIRST. A legacy file must never shadow it — moving a
		// wrapper onto the current name has to take effect on the next pass.
		if want := filepath.Join("/home/dev", ".claude", "pdmux-usage.json"); len(asked) == 0 || asked[0] != want {
			t.Fatalf("first read %v, want %q", asked, want)
		}

		// ⚠ THE CHEAP PATH FIRST, AND THE ORDER IS THE POINT. Spawning this CLI was
		// measured at ~134 MiB and ~0.28 s per pass — more than everything else the
		// agent did — so the transcript on disk has to be asked before it, and the
		// spawn has to remain only as the answer for a host that has no transcript.
		codex := NewProvider("codex", RegistryOptions{Home: "/home/dev", Now: fixedClock(testNow)})
		composed, ok := codex.(*FirstAnswering)
		if !ok {
			t.Fatalf("codex = %T, want the cheap-first composite", codex)
		}
		if len(composed.providers) != 2 {
			t.Fatalf("members = %d, want 2", len(composed.providers))
		}
		if _, ok := composed.providers[0].(*RolloutFileProvider); !ok {
			t.Fatalf("first = %T, want the transcript reader", composed.providers[0])
		}
		if _, ok := composed.providers[1].(*RPCCLIProvider); !ok {
			t.Fatalf("fallback = %T, want the JSON-RPC provider", composed.providers[1])
		}
		if codex.ID() != "codex" {
			t.Fatalf("id = %q", codex.ID())
		}
	})

	t.Run("ignores blanks and builds one adapter per CLI", func(t *testing.T) {
		// The same CLI listed twice would be spawned twice and drawn as two cards
		// for one budget.
		got := NewProviders([]string{" claude ", "claude", "", "   ", "codex"}, RegistryOptions{Home: "/home/dev"})
		if len(got) != 2 {
			t.Fatalf("providers = %d, want 2", len(got))
		}
		if got[0].ID() != "claude" || got[1].ID() != "codex" {
			t.Fatalf("ids = %q,%q", got[0].ID(), got[1].ID())
		}
		if empty := NewProviders(nil, RegistryOptions{}); empty == nil {
			t.Fatal("providers = nil, want an empty list")
		}
	})
}

func TestSnapshotFallbacks(t *testing.T) {
	// A statusline wrapper outlives the deployment that told the operator to install it.
	// Measured on this fleet: a wrapper from the predecessor tool wrote a valid snapshot
	// every few seconds into `dev-ws-usage.json` while the agent read `pdmux-usage.json`,
	// so the card said "no budget reported" beside five live processes.
	legacy := filepath.Join("/home/dev", ".claude", "dev-ws-usage.json")
	canonical := filepath.Join("/home/dev", ".claude", "pdmux-usage.json")
	snapshot := `{"five_hour":{"used_pct":12,"remaining_pct":88,"resets_at":` +
		strconv.FormatInt(testNow+60, 10) + `}}`

	t.Run("[TC-PDAGENT-103] reads a legacy snapshot when the current name is absent", func(t *testing.T) {
		provider := NewProvider("claude", RegistryOptions{
			Home: "/home/dev",
			ReadFile: func(path string) (string, bool) {
				if path == legacy {
					return snapshot, true
				}
				return "", false
			},
			Now: fixedClock(testNow),
		})
		got := provider.Windows(t.Context())
		if len(got) != 1 {
			t.Fatalf("windows = %d, want 1 — the legacy snapshot was not read", len(got))
		}
		if remaining := mustInt(t, got[0].RemainingPct, "remainingPct"); remaining != 88 {
			t.Fatalf("remainingPct = %d, want 88", remaining)
		}
	})

	t.Run("[TC-PDAGENT-103] prefers the current name over a legacy one", func(t *testing.T) {
		// Both exist. Moving the wrapper to the canonical name must take effect at once,
		// not be shadowed by a file nobody remembers writing.
		provider := NewProvider("claude", RegistryOptions{
			Home: "/home/dev",
			ReadFile: func(path string) (string, bool) {
				if path == canonical {
					return `{"five_hour":{"remaining_pct":41,"resets_at":` +
						strconv.FormatInt(testNow+60, 10) + `}}`, true
				}
				if path == legacy {
					return snapshot, true
				}
				return "", false
			},
			Now: fixedClock(testNow),
		})
		got := provider.Windows(t.Context())
		if len(got) != 1 {
			t.Fatalf("windows = %d, want 1", len(got))
		}
		if remaining := mustInt(t, got[0].RemainingPct, "remainingPct"); remaining != 41 {
			t.Fatalf("remainingPct = %d, want 41 — the legacy file shadowed the current one", remaining)
		}
	})

	t.Run("[TC-PDAGENT-103] still reports nothing when no snapshot exists at all", func(t *testing.T) {
		// A miss is a fact about the host, not an error — and must stay a miss rather
		// than becoming a row of zeros.
		provider := NewProvider("claude", RegistryOptions{
			Home:     "/home/dev",
			ReadFile: func(string) (string, bool) { return "", false },
			Now:      fixedClock(testNow),
		})
		if got := provider.Windows(t.Context()); len(got) != 0 {
			t.Fatalf("windows = %d, want 0", len(got))
		}
	})
}

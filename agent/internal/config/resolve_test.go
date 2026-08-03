package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The same two-file host the TypeScript spec describes: a user copy and a system
// copy that disagree, so precedence is observable rather than assumed.
func fixtureReader(t *testing.T) ReadFileFunc {
	t.Helper()
	files := map[string]string{
		SystemConfigPath:            `{"server":"https://system.example","token":"system-token"}`,
		UserConfigPath("/home/dev"): `{"server":"https://user.example","token":"user-token"}`,
	}
	return func(path string) (string, bool) {
		text, ok := files[path]
		return text, ok
	}
}

func TestResolve(t *testing.T) {
	read := fixtureReader(t)

	t.Run("[TC-PDAGENT-001] prefers a CLI flag over env and file", func(t *testing.T) {
		resolved := Resolve(Input{
			Flags:    Flags{Server: "https://flag.example", Token: "flag-token"},
			Env:      map[string]string{"HOME": "/home/dev", EnvServer: "https://env.example", EnvToken: "env-token"},
			ReadFile: read,
		})
		if resolved.Server != "https://flag.example" || resolved.Token != "flag-token" {
			t.Fatalf("flags did not win: %+v", resolved)
		}
		if resolved.Sources.Server != SourceFlag {
			t.Fatalf("source = %q, want flag", resolved.Sources.Server)
		}
	})

	t.Run("[TC-PDAGENT-001] prefers env over the config file", func(t *testing.T) {
		resolved := Resolve(Input{
			Env:      map[string]string{"HOME": "/home/dev", EnvServer: "https://env.example", EnvToken: "env-token"},
			ReadFile: read,
		})
		if resolved.Server != "https://env.example" {
			t.Fatalf("server = %q, want the env value", resolved.Server)
		}
		if resolved.Sources.Token != SourceEnv {
			t.Fatalf("token source = %q, want env", resolved.Sources.Token)
		}
	})

	t.Run("[TC-PDAGENT-001] falls back to the config file, user copy first", func(t *testing.T) {
		resolved := Resolve(Input{Env: map[string]string{"HOME": "/home/dev"}, ReadFile: read})
		if resolved.ConfigPath != UserConfigPath("/home/dev") {
			t.Fatalf("configPath = %q, want the user file", resolved.ConfigPath)
		}
		if resolved.Server != "https://user.example" {
			t.Fatalf("server = %q, want the user file's value", resolved.Server)
		}
		if resolved.Sources.Server != SourceFile {
			t.Fatalf("source = %q, want file", resolved.Sources.Server)
		}
	})

	t.Run("[TC-PDAGENT-001] mixes sources key by key", func(t *testing.T) {
		resolved := Resolve(Input{
			Flags:    Flags{Token: "flag-token"},
			Env:      map[string]string{"HOME": "/home/dev"},
			ReadFile: read,
		})
		if resolved.Server != "https://user.example" || resolved.Token != "flag-token" {
			t.Fatalf("mixed resolution wrong: %+v", resolved)
		}
		if resolved.Sources.Server != SourceFile || resolved.Sources.Token != SourceFlag {
			t.Fatalf("sources = %+v, want {file, flag}", resolved.Sources)
		}
	})

	t.Run("[TC-PDAGENT-001] reads the real environment when none is injected", func(t *testing.T) {
		t.Setenv(EnvServer, "https://real-env.example")
		t.Setenv(EnvToken, "real-env-token")
		// Candidates are pinned so this never consults a developer's own /etc or ~.
		resolved := Resolve(Input{Candidates: []string{}, ReadFile: read})
		if resolved.Server != "https://real-env.example" || resolved.Sources.Server != SourceEnv {
			t.Fatalf("os environment ignored: %+v", resolved)
		}
	})

	t.Run("[TC-PDAGENT-001] reports nothing configured as a default", func(t *testing.T) {
		resolved := Resolve(Input{Candidates: []string{}, Env: map[string]string{}})
		if resolved.Server != "" || resolved.Token != "" {
			t.Fatalf("expected empty values, got %+v", resolved)
		}
		if resolved.Sources.Server != SourceDefault || resolved.ConfigPath != "" {
			t.Fatalf("sources = %+v, configPath = %q", resolved.Sources, resolved.ConfigPath)
		}
	})
}

func TestConfigFileHandling(t *testing.T) {
	t.Run("[TC-PDAGENT-002] reports an unreadable config instead of silently ignoring it", func(t *testing.T) {
		resolved := Resolve(Input{
			Env: map[string]string{"HOME": "/home/dev"},
			ReadFile: func(path string) (string, bool) {
				if path == UserConfigPath("/home/dev") {
					return "{ not json", true
				}
				return "", false
			},
		})
		if !strings.Contains(strings.Join(resolved.Warnings, " "), "not valid JSON") {
			t.Fatalf("warnings = %v, want one naming invalid JSON", resolved.Warnings)
		}
		if resolved.Server != "" {
			t.Fatalf("a broken file must not produce a value, got %q", resolved.Server)
		}
	})

	t.Run("[TC-PDAGENT-002] names the offending path in the warning", func(t *testing.T) {
		resolved := Resolve(Input{
			Candidates: []string{"/etc/pdmux/agent.json"},
			Env:        map[string]string{},
			ReadFile:   func(string) (string, bool) { return `["not","an","object"]`, true },
		})
		if len(resolved.Warnings) != 1 || !strings.HasPrefix(resolved.Warnings[0], "/etc/pdmux/agent.json: ") {
			t.Fatalf("warnings = %v, want the path prefixed", resolved.Warnings)
		}
		if !strings.Contains(resolved.Warnings[0], "not a JSON object") {
			t.Fatalf("warning = %q, want it to say the shape is wrong", resolved.Warnings[0])
		}
	})

	t.Run("[TC-PDAGENT-002] keeps walking past a broken file to a good one", func(t *testing.T) {
		resolved := Resolve(Input{
			Candidates: []string{"/broken.json", "/good.json"},
			Env:        map[string]string{},
			ReadFile: func(path string) (string, bool) {
				if path == "/broken.json" {
					return "{oops", true
				}
				return `{"server":"https://good.example"}`, true
			},
		})
		if resolved.ConfigPath != "/good.json" || resolved.Server != "https://good.example" {
			t.Fatalf("did not fall through to the good file: %+v", resolved)
		}
		if len(resolved.Warnings) != 1 {
			t.Fatalf("warnings = %v, want the broken file still reported", resolved.Warnings)
		}
	})

	t.Run("[TC-PDAGENT-002] puts an explicit --config ahead of every default path", func(t *testing.T) {
		got := Candidates(Input{
			Flags: Flags{Config: "/tmp/custom.json"},
			Env:   map[string]string{"HOME": "/home/dev", EnvConfig: "/tmp/from-env.json"},
		})
		want := []string{
			"/tmp/custom.json",
			"/tmp/from-env.json",
			"/home/dev/.config/pdmux/agent.json",
			"/etc/pdmux/agent.json",
		}
		if len(got) != len(want) {
			t.Fatalf("candidates = %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("candidates = %v, want %v", got, want)
			}
		}
	})

	t.Run("[TC-PDAGENT-002] reads a real file with the default reader", func(t *testing.T) {
		// t.TempDir keeps this off the developer's real ~ and /etc.
		dir := t.TempDir()
		path := filepath.Join(dir, "agent.json")
		if err := os.WriteFile(path, []byte(`{"server":"https://disk.example","logLevel":"debug"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		resolved := Resolve(Input{Candidates: []string{path}, Env: map[string]string{}})
		if resolved.Server != "https://disk.example" || resolved.LogLevel != "debug" {
			t.Fatalf("file not read: %+v", resolved)
		}
		if resolved.ConfigPath != path {
			t.Fatalf("configPath = %q, want %q", resolved.ConfigPath, path)
		}
	})

	t.Run("[TC-PDAGENT-002] ignores a non-string value instead of coercing it", func(t *testing.T) {
		resolved := Resolve(Input{
			Candidates: []string{"/c.json"},
			Env:        map[string]string{},
			ReadFile:   func(string) (string, bool) { return `{"server":5002,"token":""}`, true },
		})
		if resolved.Server != "" || resolved.Sources.Server != SourceDefault {
			t.Fatalf("a numeric server must fall through, got %+v", resolved)
		}
		if len(resolved.Warnings) != 0 {
			t.Fatalf("a wrong-typed key is not a broken file: %v", resolved.Warnings)
		}
	})
}

func TestToWebSocketURL(t *testing.T) {
	t.Run("[TC-PDAGENT-003] upgrades http(s) to ws(s) and appends the agent path", func(t *testing.T) {
		assertURL(t, "https://pdmux.example.com", "wss://pdmux.example.com/agent/ws")
		assertURL(t, "http://localhost:5002", "ws://localhost:5002/agent/ws")
	})

	t.Run("[TC-PDAGENT-003] accepts a bare host and a trailing slash", func(t *testing.T) {
		assertURL(t, "pdmux.example.com/", "wss://pdmux.example.com/agent/ws")
		assertURL(t, "  localhost:5002  ", "wss://localhost:5002/agent/ws")
	})

	t.Run("[TC-PDAGENT-003] leaves an explicit agent endpoint alone", func(t *testing.T) {
		assertURL(t, "wss://pdmux.example.com/agent/ws", "wss://pdmux.example.com/agent/ws")
		// A server behind a path prefix keeps the prefix.
		assertURL(t, "https://example.com/pdmux", "wss://example.com/pdmux/agent/ws")
	})

	t.Run("[TC-PDAGENT-003] refuses a scheme it cannot dial", func(t *testing.T) {
		if _, err := ToWebSocketURL("ftp://pdmux.example.com"); err == nil ||
			!strings.Contains(err.Error(), "unsupported") {
			t.Fatalf("err = %v, want an unsupported-scheme error", err)
		}
		if _, err := ToWebSocketURL(""); err == nil {
			t.Fatal("an empty server address must be refused, not dialled")
		}
	})
}

func assertURL(t *testing.T, input, want string) {
	t.Helper()
	got, err := ToWebSocketURL(input)
	if err != nil {
		t.Fatalf("ToWebSocketURL(%q) failed: %v", input, err)
	}
	if got != want {
		t.Fatalf("ToWebSocketURL(%q) = %q, want %q", input, got, want)
	}
}

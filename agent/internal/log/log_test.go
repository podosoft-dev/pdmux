package log

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// collector is the injected sink: a spec asserts on what was written, never on
// stderr.
type collector struct {
	mu    sync.Mutex
	lines []string
}

func (c *collector) sink(line string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, line)
}

func (c *collector) joined() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.lines, "\n")
}

func fixedClock() func() time.Time {
	at := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	return func() time.Time { return at }
}

func TestRedaction(t *testing.T) {
	t.Run("[TC-PDAGENT-030] never writes the token into a log line", func(t *testing.T) {
		lines := &collector{}
		logger := New(Options{Level: LevelDebug, Sink: lines.sink, Now: fixedClock()})
		logger.AddSecret("super-secret-token")
		logger.Info("Connecting to server", F("url", "wss://x/agent/ws?token=super-secret-token"))
		logger.Warn("Retrying with key", F("token", "super-secret-token"))
		logger.Error("Raw mention super-secret-token in the message")

		if strings.Contains(lines.joined(), "super-secret-token") {
			t.Fatalf("token leaked into the log:\n%s", lines.joined())
		}
		for _, line := range lines.lines {
			if !strings.Contains(line, Redacted) {
				t.Fatalf("line without a redaction marker: %q", line)
			}
		}
	})

	t.Run("[TC-PDAGENT-030] redacts a secret registered before the first line", func(t *testing.T) {
		// The ordering property from main.ts: the token goes in at construction, so
		// there is no window — not even the connect line, which carries the URL —
		// in which a logger exists that does not know the secret.
		lines := &collector{}
		logger := New(Options{
			Level:   LevelInfo,
			Sink:    lines.sink,
			Secrets: []string{"tok_abcdef123456"},
			Now:     fixedClock(),
		})
		logger.Info("Starting agent", F("url", "wss://x/agent/ws"), F("key", "tok_abcdef123456"))
		if strings.Contains(lines.joined(), "tok_abcdef123456") {
			t.Fatalf("constructor secret leaked: %s", lines.joined())
		}
	})

	t.Run("[TC-PDAGENT-030] redacts a self-naming assignment it was never told about", func(t *testing.T) {
		// The value is unknown to the logger; the field name gives it away. The
		// match stops at whitespace, a comma or a quote — the delimiters a value
		// actually ends on in a URL, a header dump or a JSON fragment.
		for _, sample := range []struct{ line, secret string }{
			{`GET /agent/ws?token=nevertoldyou, next`, "nevertoldyou"},
			{`x-api-key: other-value in a header dump`, "other-value"},
			{`Authorization: tok_abcdef trailing words`, "tok_abcdef"},
		} {
			got := Redact(sample.line, nil)
			if strings.Contains(got, sample.secret) {
				t.Fatalf("self-naming secret survived: %q", got)
			}
			if !strings.Contains(got, Redacted) {
				t.Fatalf("nothing was redacted in %q", got)
			}
		}
	})

	t.Run("[TC-PDAGENT-030] leaves short secrets alone", func(t *testing.T) {
		// Redacting "dev" would punch holes in ordinary messages.
		if got := Redact("running in dev mode", []string{"dev"}); got != "running in dev mode" {
			t.Fatalf("short secret was redacted: %q", got)
		}
		if got := Redact("host is devbox1 today", []string{"devbox1"}); !strings.Contains(got, Redacted) {
			t.Fatalf("a long enough secret must be redacted: %q", got)
		}
	})

	t.Run("[TC-PDAGENT-030] redacts a secret-named field whatever its value", func(t *testing.T) {
		lines := &collector{}
		logger := New(Options{Sink: lines.sink, Now: fixedClock()})
		logger.Info("auth", F("Authorization", 12345), F("password", ""), F("apikey", nil))
		for _, name := range []string{"Authorization=***", "password=***", "apikey=***"} {
			if !strings.Contains(lines.joined(), name) {
				t.Fatalf("missing %s in %q", name, lines.joined())
			}
		}
		if strings.Contains(lines.joined(), "12345") {
			t.Fatalf("a secret field's value was rendered: %q", lines.joined())
		}
	})
}

// No TC covers line shape, level filtering or field rendering — they were never
// asserted in the TypeScript either. Kept untagged rather than inventing an id.
func TestLineFormat(t *testing.T) {
	t.Run("writes timestamp, level, message then fields in call order", func(t *testing.T) {
		lines := &collector{}
		logger := New(Options{Sink: lines.sink, Now: fixedClock()})
		logger.Info("Heartbeat sent", F("host", "workshop-01"), F("cpu", 12.5), F("ok", true))
		want := "2026-07-25T12:00:00.000Z INFO Heartbeat sent host=workshop-01 cpu=12.5 ok=true"
		if lines.joined() != want {
			t.Fatalf("line = %q, want %q", lines.joined(), want)
		}
	})

	t.Run("drops empty values but keeps structured ones", func(t *testing.T) {
		lines := &collector{}
		logger := New(Options{Sink: lines.sink, Now: fixedClock()})
		logger.Info("m", F("skipped", nil), F("also", ""), F("obj", map[string]int{"n": 1}),
			F("err", errors.New("boom")), F("bad", make(chan int)))
		line := lines.joined()
		for _, absent := range []string{"skipped=", "also="} {
			if strings.Contains(line, absent) {
				t.Fatalf("empty field rendered: %q", line)
			}
		}
		for _, present := range []string{`obj={"n":1}`, "err=boom", "bad=[unserialisable]"} {
			if !strings.Contains(line, present) {
				t.Fatalf("missing %s in %q", present, line)
			}
		}
	})

	t.Run("filters below the configured level and follows SetLevel", func(t *testing.T) {
		lines := &collector{}
		logger := New(Options{Level: LevelWarn, Sink: lines.sink, Now: fixedClock()})
		logger.Debug("debug")
		logger.Info("info")
		logger.Warn("warn")
		if lines.joined() != "2026-07-25T12:00:00.000Z WARN warn" {
			t.Fatalf("level filter wrong: %q", lines.joined())
		}
		logger.SetLevel(LevelDebug)
		logger.Debug("now visible")
		if !strings.Contains(lines.joined(), "now visible") {
			t.Fatal("SetLevel did not take effect")
		}
	})

	t.Run("defaults to info and parses configured level names", func(t *testing.T) {
		lines := &collector{}
		logger := New(Options{Sink: lines.sink, Now: fixedClock()})
		logger.Debug("hidden")
		logger.Info("shown")
		if strings.Contains(lines.joined(), "hidden") || !strings.Contains(lines.joined(), "shown") {
			t.Fatalf("default level is not info: %q", lines.joined())
		}
		if level, ok := ParseLevel("warn"); !ok || level != LevelWarn {
			t.Fatalf("ParseLevel(warn) = %v, %v", level, ok)
		}
		if level, ok := ParseLevel("verbose"); ok || level != LevelInfo {
			t.Fatalf("an unknown level must be reported, not adopted: %v, %v", level, ok)
		}
	})

	t.Run("silent logger discards everything", func(t *testing.T) {
		logger := Silent()
		logger.Error("nothing observable happens here")
	})

	t.Run("survives concurrent writers", func(t *testing.T) {
		// The Node original could not race; this one is called from the socket
		// reader, the PTY pumps and the heartbeat timer at once.
		lines := &collector{}
		logger := New(Options{Sink: lines.sink, Now: fixedClock()})
		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				logger.AddSecret("concurrent-secret-value")
				logger.Info("beat", F("token", "concurrent-secret-value"))
			}()
		}
		wg.Wait()
		if len(lines.lines) != 16 {
			t.Fatalf("wrote %d lines, want 16", len(lines.lines))
		}
		if strings.Contains(lines.joined(), "concurrent-secret-value") {
			t.Fatal("secret leaked under concurrency")
		}
	})
}

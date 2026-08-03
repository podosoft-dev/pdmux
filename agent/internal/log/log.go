// Package log is one-line structured logging with secret redaction.
//
// WHY REDACTION LIVES IN THE LOGGER: the agent's key is on the connection URL,
// in the config file, in the install output and in every reconnect message. A
// "remember not to log the token" rule is one careless format string away from
// writing a working credential into journald, where it stays for weeks.
// Registering the secret once means no call site has to remember.
//
// Ported from apps/agent/src/log.ts.
package log

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Level is a severity. The values are the TypeScript's ORDER table, so the
// comparison that filters a line is the same comparison it was there.
type Level int

const (
	LevelDebug Level = 10
	LevelInfo  Level = 20
	LevelWarn  Level = 30
	LevelError Level = 40
)

// Redacted is what a secret is replaced with.
const Redacted = "***"

// The timestamp the TypeScript produced with toISOString(): UTC, milliseconds,
// trailing Z. Kept identical so log lines from a Go agent and a Node agent sort
// and grep the same way while both are in the field.
const timeLayout = "2006-01-02T15:04:05.000Z07:00"

func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelInfo:
		return "info"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	default:
		return "info"
	}
}

// ParseLevel maps a configured string onto a level; ok is false for anything
// else, which the caller reports rather than guessing at.
func ParseLevel(value string) (Level, bool) {
	switch value {
	case "debug":
		return LevelDebug, true
	case "info":
		return LevelInfo, true
	case "warn":
		return LevelWarn, true
	case "error":
		return LevelError, true
	default:
		return LevelInfo, false
	}
}

// Fields that carry a credential whatever their value looks like.
var secretKey = regexp.MustCompile(`(?i)^(token|key|apikey|api_key|secret|authorization|password)$`)

// `token=abc`, `x-api-key: abc`, `?token=abc` — a value that names itself.
var inlineSecret = regexp.MustCompile(`(?i)((?:x-api-key|api[-_]?key|token|authorization|secret)\s*[:=]\s*)([^\s,;"']+)`)

// Redact replaces every registered secret (and self-naming assignment) with ***.
func Redact(text string, secrets []string) string {
	out := text
	for _, secret := range secrets {
		// Short strings would redact innocent words ("dev", "abc") out of messages.
		if utf8.RuneCountInString(secret) < 6 {
			continue
		}
		out = strings.ReplaceAll(out, secret, Redacted)
	}
	return inlineSecret.ReplaceAllString(out, "${1}"+Redacted)
}

// Field is one key/value pair on a log line.
//
// WHY AN ORDERED SLICE AND NOT A MAP: the TypeScript takes a plain object and
// gets insertion order for free. Go map iteration is deliberately randomised, so
// the same call would print its fields in a different order on every beat —
// unreadable when tailing journald, and impossible to assert in a spec.
type Field struct {
	Key   string
	Value any
}

// F builds a Field. It is short because the alternative at a call site is a
// composite literal per field, and a logger that is tedious to call gets called
// with a concatenated string instead.
func F(key string, value any) Field { return Field{Key: key, Value: value} }

// Options configure a Logger. Every dependency is injectable so a spec can read
// what was written and assert a stable line.
type Options struct {
	// Level is the minimum severity that reaches the sink; zero means info.
	Level Level
	// Sink is where lines go; nil writes to stderr.
	Sink func(line string)
	// Secrets are values that must never appear in output. Passing the token here
	// (rather than calling AddSecret afterwards) is what makes it impossible for
	// the very first line — the connect line, which carries the URL — to leak it.
	Secrets []string
	// Now is the clock; nil uses time.Now.
	Now func() time.Time
}

// Logger writes one-line structured records with secrets redacted.
type Logger struct {
	// The Node original was single-threaded. A Go agent logs from the socket
	// reader, every PTY pump and the heartbeat timer at once, so the secret list
	// and the sink need a lock: an unsynchronised append here is a data race, and
	// two goroutines sharing a sink would interleave halves of two lines.
	mu      sync.Mutex
	level   Level
	secrets []string
	sink    func(line string)
	now     func() time.Time
}

// New builds a Logger.
func New(options Options) *Logger {
	level := options.Level
	if level == 0 {
		level = LevelInfo
	}
	sink := options.Sink
	if sink == nil {
		sink = func(line string) {
			fmt.Fprintln(os.Stderr, line)
		}
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Logger{
		level:   level,
		secrets: append([]string(nil), options.Secrets...),
		sink:    sink,
		now:     now,
	}
}

// Silent returns a logger that discards everything — the default for library use
// in specs.
func Silent() *Logger {
	return New(Options{Level: LevelError, Sink: func(string) {}})
}

// AddSecret registers a value that must never appear in output.
func (l *Logger) AddSecret(secret string) {
	if secret == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.secrets = append(l.secrets, secret)
}

// SetLevel changes the minimum severity. The server can retune it on a live
// agent, so it has to be changeable after construction.
func (l *Logger) SetLevel(level Level) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.level = level
}

func (l *Logger) Debug(message string, fields ...Field) { l.write(LevelDebug, message, fields) }
func (l *Logger) Info(message string, fields ...Field)  { l.write(LevelInfo, message, fields) }
func (l *Logger) Warn(message string, fields ...Field)  { l.write(LevelWarn, message, fields) }
func (l *Logger) Error(message string, fields ...Field) { l.write(LevelError, message, fields) }

func (l *Logger) write(level Level, message string, fields []Field) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if level < l.level {
		return
	}
	parts := make([]string, 0, 3+len(fields))
	parts = append(parts, l.now().UTC().Format(timeLayout), strings.ToUpper(level.String()), message)
	for _, field := range fields {
		// A secret key is redacted before its value is ever rendered — the value
		// never reaches a string, so it cannot survive in one.
		rendered := Redacted
		if !secretKey.MatchString(field.Key) {
			rendered = renderValue(field.Value)
		}
		if rendered == "" {
			continue
		}
		parts = append(parts, field.Key+"="+rendered)
	}
	// The sink is called under the lock on purpose: a line is written whole or not
	// at all, even when several goroutines log into the same stderr.
	l.sink(Redact(strings.Join(parts, " "), l.secrets))
}

func renderValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case error:
		// Not in the TypeScript, where call sites wrote String(error) themselves.
		// Go's json.Marshal renders most error types as "{}" (their fields are
		// unexported), so without this every failure would log as an empty object.
		return typed.Error()
	case int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64,
		float32, float64:
		return fmt.Sprintf("%v", typed)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "[unserialisable]"
	}
	return string(encoded)
}

// Package config resolves the agent's settings: CLI flags > environment > file.
//
// WHY THAT ORDER: the file is what `install` writes and what systemd runs with,
// the environment is how a container overrides it without a rebuild, and a flag
// is a human debugging a live host who must be able to win over both without
// editing a root-owned file first.
//
// Ported from apps/agent/src/config/resolve.ts. Absence is modelled as the empty
// string rather than a pointer: the TypeScript already treated an empty string as
// absent everywhere (`if (flag)`, and a file value had to be non-empty), so the
// Go zero value carries exactly the meaning `null` did there — and no call site
// has to nil-check a string it is about to test for emptiness anyway.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// Source records which layer a resolved value came from. `doctor` prints it, so
// an operator can see why the agent is dialling what it is dialling.
type Source string

const (
	SourceFlag    Source = "flag"
	SourceEnv     Source = "env"
	SourceFile    Source = "file"
	SourceDefault Source = "default"
)

// Environment variable names. They are part of the agent's public surface: a
// container image or a systemd drop-in sets these, so renaming one is a breaking
// change for every host already running.
const (
	EnvServer   = "PDMUX_SERVER"
	EnvToken    = "PDMUX_TOKEN"
	EnvHostname = "PDMUX_HOSTNAME"
	EnvLogLevel = "PDMUX_LOG_LEVEL"
	EnvConfig   = "PDMUX_CONFIG"
)

// SystemConfigPath is what `install --system` writes and what systemd reads.
const SystemConfigPath = "/etc/pdmux/agent.json"

// FileConfig is the part of a config file the agent understands.
type FileConfig struct {
	Server string `json:"server"`
	Token  string `json:"token"`
	// Hostname overrides the reported hostname (containers report their container id).
	Hostname string `json:"hostname"`
	LogLevel string `json:"logLevel"`
}

// Flags are the values a human typed on the command line.
type Flags struct {
	Server   string
	Token    string
	Config   string
	Hostname string
	LogLevel string
}

// ReadFileFunc reads a candidate config file; ok is false when it is absent or
// unreadable. Injected so specs never touch a real /etc.
type ReadFileFunc func(path string) (text string, ok bool)

// Input is everything Resolve needs. Every external dependency is injectable so
// a spec can describe a whole host without owning one.
type Input struct {
	Flags Flags
	// Env is the process environment; nil reads the real one.
	Env map[string]string
	// ReadFile reads a candidate path; nil reads the real filesystem.
	ReadFile ReadFileFunc
	// Candidates are config paths, most specific first; nil calls Candidates.
	Candidates []string
	HomeDir    string
}

// Sources says where each resolved value came from.
type Sources struct {
	Server   Source
	Token    Source
	Hostname Source
	LogLevel Source
}

// Resolved is the merged configuration plus the provenance `doctor` reports.
type Resolved struct {
	Server   string
	Token    string
	Hostname string
	LogLevel string
	// ConfigPath is the file that supplied the file layer, empty when none did.
	ConfigPath string
	Sources    Sources
	// Warnings are non-fatal problems (unreadable/invalid file) — `doctor` prints them.
	Warnings []string
}

// UserConfigPath is the per-user config file inside a home directory.
func UserConfigPath(homeDir string) string {
	return filepath.Join(homeDir, ".config", "pdmux", "agent.json")
}

// Candidates lists config paths, most specific first.
//
// The USER file is consulted before the system one on purpose: a developer on a
// shared box must be able to point their agent somewhere else without sudo.
func Candidates(in Input) []string {
	var out []string
	if in.Flags.Config != "" {
		out = append(out, in.Flags.Config)
	}
	env := in.Env
	if env == nil {
		env = OSEnv()
	}
	if fromEnv := env[EnvConfig]; fromEnv != "" {
		out = append(out, fromEnv)
	}
	home := in.HomeDir
	if home == "" {
		home = env["HOME"]
	}
	if home != "" {
		out = append(out, UserConfigPath(home))
	}
	return append(out, SystemConfigPath)
}

// OSEnv snapshots the process environment as a map, so the rest of the package
// can stay a pure function of its input.
func OSEnv() map[string]string {
	environ := os.Environ()
	out := make(map[string]string, len(environ))
	for _, entry := range environ {
		if i := strings.IndexByte(entry, '='); i > 0 {
			out[entry[:i]] = entry[i+1:]
		}
	}
	return out
}

// ReadFileOrMissing is the default reader: an absent or unreadable candidate is
// "no config here", not an error — the candidate list exists to be walked.
func ReadFileOrMissing(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

func parseFile(text string) (FileConfig, error) {
	var document any
	if err := json.Unmarshal([]byte(text), &document); err != nil {
		return FileConfig{}, fmt.Errorf("config file is not valid JSON: %w", err)
	}
	record, ok := document.(map[string]any)
	if !ok {
		// A list or a bare scalar is a different mistake from broken syntax, and
		// saying which one it is saves the operator a round trip.
		return FileConfig{}, errors.New("config file is not a JSON object")
	}
	// A non-string (or empty) value is treated as absent rather than coerced: a
	// port number typed as a number should fall through to the next layer, not
	// become the string "5002" in a field that wanted a URL.
	pick := func(key string) string {
		value, _ := record[key].(string)
		return value
	}
	return FileConfig{
		Server:   pick("server"),
		Token:    pick("token"),
		Hostname: pick("hostname"),
		LogLevel: pick("logLevel"),
	}, nil
}

func pickValue(flag, env, file string) (string, Source) {
	if flag != "" {
		return flag, SourceFlag
	}
	if env != "" {
		return env, SourceEnv
	}
	if file != "" {
		return file, SourceFile
	}
	return "", SourceDefault
}

// Resolve merges the three layers and reports where each value came from.
func Resolve(in Input) Resolved {
	candidates := in.Candidates
	if candidates == nil {
		candidates = Candidates(in)
	}
	readFile := in.ReadFile
	if readFile == nil {
		readFile = ReadFileOrMissing
	}
	env := in.Env
	if env == nil {
		env = OSEnv()
	}

	var (
		file       FileConfig
		configPath string
		warnings   []string
	)
	for _, path := range candidates {
		text, ok := readFile(path)
		if !ok {
			continue
		}
		parsed, err := parseFile(text)
		if err != nil {
			// A broken file must not silently fall through to "no config" — that
			// produces a daemon that dials nothing and says nothing about why.
			warnings = append(warnings, fmt.Sprintf("%s: %v", path, err))
			continue
		}
		file = parsed
		configPath = path
		break
	}

	server, serverSource := pickValue(in.Flags.Server, env[EnvServer], file.Server)
	token, tokenSource := pickValue(in.Flags.Token, env[EnvToken], file.Token)
	hostname, hostnameSource := pickValue(in.Flags.Hostname, env[EnvHostname], file.Hostname)
	logLevel, logLevelSource := pickValue(in.Flags.LogLevel, env[EnvLogLevel], file.LogLevel)

	return Resolved{
		Server:     server,
		Token:      token,
		Hostname:   hostname,
		LogLevel:   logLevel,
		ConfigPath: configPath,
		Sources: Sources{
			Server:   serverSource,
			Token:    tokenSource,
			Hostname: hostnameSource,
			LogLevel: logLevelSource,
		},
		Warnings: warnings,
	}
}

// A scheme is "<letter><letter|digit|+|-|.>*://". Anything else is a bare host,
// which is what people paste when they type the address from memory.
var schemePrefix = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.\-]*://`)

// ToWebSocketURL turns whatever the user typed into the WebSocket URL the agent
// dials.
//
// People paste the address they see in the browser (`https://pdmux.example.com`),
// so http(s) is accepted and upgraded here rather than rejected with a lecture.
// A URL that already carries the agent path is left alone so `--server` can also
// take the exact endpoint.
func ToWebSocketURL(server string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(server), "/")
	withScheme := trimmed
	if !schemePrefix.MatchString(withScheme) {
		withScheme = "https://" + withScheme
	}
	parsed, err := url.Parse(withScheme)
	if err != nil {
		return "", fmt.Errorf("unusable server address %q: %w", server, err)
	}
	switch parsed.Scheme {
	case "http":
		parsed.Scheme = "ws"
	case "https":
		parsed.Scheme = "wss"
	case "ws", "wss":
		// Already dialable.
	default:
		return "", fmt.Errorf("unsupported server scheme: %s", parsed.Scheme)
	}
	if parsed.Host == "" {
		// `new URL('https://')` throws in the TypeScript; Go parses the same input
		// happily and would hand back a URL that dials nothing, so the rejection
		// has to be explicit here.
		return "", fmt.Errorf("server address has no host: %q", server)
	}
	// The endpoint comes from the contract's generated constant rather than a
	// literal here: the path is one of the values a schema cannot express, so a
	// second copy would be free to drift from the route the server actually serves.
	if !strings.HasSuffix(parsed.Path, protocol.AgentWSPath) {
		parsed.Path = strings.TrimRight(parsed.Path, "/") + protocol.AgentWSPath
	}
	return parsed.String(), nil
}

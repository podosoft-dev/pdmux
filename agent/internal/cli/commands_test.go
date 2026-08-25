package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
)

const commandToken = "command-token-value"

type harness struct {
	stdout bytes.Buffer
	stderr bytes.Buffer
	home   string
	deps   Deps
}

// newHarness builds a command environment that owns nothing outside t.TempDir():
// its home, its config candidates and its unit paths all live there, and every
// host lookup is answered by the spec rather than by this machine.
func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{home: t.TempDir()}
	binary := filepath.Join(h.home, "bin", "pdmux-agent")
	if err := os.MkdirAll(filepath.Dir(binary), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(binary, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	h.deps = Deps{
		Stdout:     &h.stdout,
		Stderr:     &h.stderr,
		Env:        map[string]string{"HOME": h.home},
		Home:       h.home,
		Username:   "dev",
		Executable: binary,
		GOOS:       "linux",
		ReadConfigFile: func(path string) (string, bool) {
			if !strings.HasPrefix(path, h.home+string(os.PathSeparator)) {
				return "", false
			}
			return config.ReadFileOrMissing(path)
		},
		// The real check would consult this machine's uids; the placement branch
		// has its own tests.
		ExecDirWritable: func(string, string) bool { return true },
		Which:           func(string) bool { return true },
		Probe: func(context.Context, string, string) ProbeResult {
			return ProbeResult{OK: true, Detail: "welcomed as host abc"}
		},
	}
	return h
}

func (h *harness) run(argv ...string) int {
	return Main(context.Background(), argv, h.deps)
}

func TestCommandInstall(t *testing.T) {
	t.Run("[TC-PDAGENT-032] writes nothing at all in a dry run", func(t *testing.T) {
		h := newHarness(t)
		code := h.run("install", "--server", "https://pdmux.example.com", "--token", commandToken, "--user", "--dry-run")
		if code != 0 {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		if strings.Contains(h.stdout.String(), commandToken) {
			t.Fatalf("dry run printed the token:\n%s", h.stdout.String())
		}
		if _, err := os.Stat(filepath.Join(h.home, ".config", "pdmux", "agent.json")); !os.IsNotExist(err) {
			t.Fatal("--dry-run must write nothing")
		}
		if _, err := os.Stat(filepath.Join(h.home, ".local", "state", "pdmux")); !os.IsNotExist(err) {
			t.Fatal("--dry-run must not create the state directory either")
		}
	})

	t.Run("[TC-PDAGENT-032] installs a 0600 config and a unit that carries no credential", func(t *testing.T) {
		h := newHarness(t)
		if code := h.run("install", "--server", "https://pdmux.example.com", "--token", commandToken, "--user"); code != 0 {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		configPath := filepath.Join(h.home, ".config", "pdmux", "agent.json")
		info, err := os.Stat(configPath)
		if err != nil {
			t.Fatalf("config was not written: %v", err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("config mode = %04o", info.Mode().Perm())
		}
		unit, err := os.ReadFile(filepath.Join(h.home, ".config", "systemd", "user", UnitName))
		if err != nil {
			t.Fatalf("unit was not written: %v", err)
		}
		if bytes.Contains(unit, []byte(commandToken)) {
			t.Fatalf("unit carries the token:\n%s", unit)
		}
		// The state directory is created here because a unit cannot create it for
		// itself, and without it the ledger silently restarts from empty.
		state, err := os.Stat(filepath.Join(h.home, ".local", "state", "pdmux"))
		if err != nil || state.Mode().Perm() != 0o700 {
			t.Fatalf("state directory = %v (%v)", state, err)
		}
	})

	t.Run("refuses to install without a server and a token", func(t *testing.T) {
		h := newHarness(t)
		if code := h.run("install", "--server", "https://pdmux.example.com", "--user"); code != 2 {
			t.Fatalf("exit = %d, want 2", code)
		}
		if !strings.Contains(h.stderr.String(), "Refusing to install without --server and --token") {
			t.Fatalf("stderr = %s", h.stderr.String())
		}
		if entries, err := os.ReadDir(filepath.Join(h.home, ".config")); err == nil && len(entries) > 0 {
			t.Fatalf("a refused install wrote %v", entries)
		}
	})

	t.Run("exits 1 when a write fails", func(t *testing.T) {
		h := newHarness(t)
		// Something else is already sitting on the config path. Whatever the cause
		// — a directory left by a packaging mistake, a read-only mount, no
		// permission — the install must fail loudly rather than print the enable
		// commands for a unit whose credential never landed.
		if err := os.MkdirAll(filepath.Join(h.home, ".config", "pdmux", "agent.json"), 0o755); err != nil {
			t.Fatal(err)
		}
		code := h.run("install", "--server", "https://pdmux.example.com", "--token", commandToken, "--user")
		if code != 1 {
			t.Fatalf("exit = %d, want 1 (stderr: %s)", code, h.stderr.String())
		}
		if !strings.Contains(h.stderr.String(), "Failed to write installation files") {
			t.Fatalf("stderr = %s", h.stderr.String())
		}
	})
}

func TestCommandDoctor(t *testing.T) {
	t.Run("[TC-PDAGENT-033] exits 0 only when every check passed", func(t *testing.T) {
		h := newHarness(t)
		code := h.run("doctor", "--server", "https://pdmux.example.com", "--token", commandToken)
		if code != 0 {
			t.Fatalf("exit = %d, report:\n%s", code, h.stdout.String())
		}
		if !strings.Contains(h.stdout.String(), "All checks passed.") {
			t.Fatalf("report:\n%s", h.stdout.String())
		}
		if strings.Contains(h.stdout.String(), commandToken) {
			t.Fatalf("report leaked the token:\n%s", h.stdout.String())
		}
	})

	t.Run("[TC-PDAGENT-033] exits 1 when a check failed", func(t *testing.T) {
		h := newHarness(t)
		h.deps.Probe = func(context.Context, string, string) ProbeResult {
			return ProbeResult{Detail: "closed before welcome (code 4401 unauthorised)"}
		}
		code := h.run("doctor", "--server", "https://pdmux.example.com", "--token", commandToken)
		if code != 1 {
			t.Fatalf("exit = %d, want 1", code)
		}
		if !strings.Contains(h.stdout.String(), "FAIL  connectivity") {
			t.Fatalf("report:\n%s", h.stdout.String())
		}
	})

	t.Run("[TC-PDAGENT-033] reports an unusable server address instead of dialling it", func(t *testing.T) {
		h := newHarness(t)
		h.deps.Probe = func(context.Context, string, string) ProbeResult {
			t.Fatal("an address that cannot be parsed must not be dialled")
			return ProbeResult{}
		}
		if code := h.run("doctor", "--server", "ftp://pdmux.example.com", "--token", commandToken); code != 1 {
			t.Fatalf("exit = %d, want 1", code)
		}
		if !strings.Contains(h.stdout.String(), "unsupported server scheme") {
			t.Fatalf("report must say what is wrong with the value:\n%s", h.stdout.String())
		}
	})
}

func TestCommandVerify(t *testing.T) {
	t.Run("exits 0 only when a welcome actually arrived", func(t *testing.T) {
		h := newHarness(t)
		if code := h.run("verify", "--server", "https://pdmux.example.com", "--token", commandToken); code != 0 {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		if !strings.Contains(h.stdout.String(), "welcomed as host abc") {
			t.Fatalf("stdout = %s", h.stdout.String())
		}
		if strings.Contains(h.stdout.String(), commandToken) {
			t.Fatalf("verify leaked the token:\n%s", h.stdout.String())
		}
	})

	t.Run("exits 1 when the server never welcomed us", func(t *testing.T) {
		h := newHarness(t)
		h.deps.Probe = func(context.Context, string, string) ProbeResult {
			return ProbeResult{Detail: "closed before welcome (code 4401 unauthorised)"}
		}
		if code := h.run("verify", "--server", "https://pdmux.example.com", "--token", commandToken); code != 1 {
			t.Fatalf("exit = %d, want 1", code)
		}
		if !strings.Contains(h.stderr.String(), "4401") {
			t.Fatalf("stderr = %s", h.stderr.String())
		}
	})

	t.Run("refuses without a server and a token", func(t *testing.T) {
		h := newHarness(t)
		if code := h.run("verify"); code != 2 {
			t.Fatalf("exit = %d, want 2", code)
		}
	})

	t.Run("reads the config file the daemon would read", func(t *testing.T) {
		// The point of `verify --config` is to ask "would the INSTALLED agent
		// connect", so it has to resolve exactly the way `run` does.
		h := newHarness(t)
		path := filepath.Join(h.home, "agent.json")
		if err := os.WriteFile(path, []byte(`{"server":"https://from-file.example","token":"`+commandToken+`"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		var dialled string
		h.deps.Probe = func(_ context.Context, url, token string) ProbeResult {
			dialled = url
			if token != commandToken {
				t.Fatalf("token = %q", token)
			}
			return ProbeResult{OK: true, Detail: "welcomed as host abc"}
		}
		if code := h.run("verify", "--config", path); code != 0 {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		if dialled != "wss://from-file.example/agent/ws" {
			t.Fatalf("dialled %q", dialled)
		}
	})
}

func TestCommandRun(t *testing.T) {
	t.Run("refuses to start without a server and a token", func(t *testing.T) {
		h := newHarness(t)
		h.deps.Daemon = func(context.Context, DaemonConfig) error {
			t.Fatal("the daemon must not start without a credential")
			return nil
		}
		if code := h.run("run"); code != 2 {
			t.Fatalf("exit = %d, want 2", code)
		}
		if !strings.Contains(h.stderr.String(), "Refusing to start without a server and token") {
			t.Fatalf("stderr = %s", h.stderr.String())
		}
	})

	t.Run("hands the daemon a normalised url and never logs the token", func(t *testing.T) {
		h := newHarness(t)
		var got DaemonConfig
		h.deps.Daemon = func(_ context.Context, cfg DaemonConfig) error {
			got = cfg
			return nil
		}
		if code := h.run("run", "--server", "pdmux.example.com", "--token", commandToken); code != 0 {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		if got.URL != "wss://pdmux.example.com/agent/ws" {
			t.Fatalf("url = %q", got.URL)
		}
		if got.Token != commandToken || got.Version != AgentVersion {
			t.Fatalf("config = %+v", got)
		}
		// The logger must already know the secret when it writes its first line —
		// that line names the host and, one layer down, the URL it dials.
		got.Logger.Info("connecting", log.F("secret", commandToken))
		if strings.Contains(h.stderr.String(), commandToken) {
			t.Fatalf("the token reached the log:\n%s", h.stderr.String())
		}
	})

	t.Run("hands the daemon the config file this run resolved", func(t *testing.T) {
		// Remote update execs the CANDIDATE binary as `verify --config <this path>`,
		// so Gate 1 exercises the file this host is actually configured by. Passing
		// the flag instead of the resolved path would leave every host configured
		// entirely by /etc/pdmux/agent.json verifying against no config at all — and
		// a new build that regressed its config parser would sail through.
		h := newHarness(t)
		path := filepath.Join(h.home, "agent.json")
		if err := os.WriteFile(path, []byte(`{"server":"https://from-file.example","token":"`+commandToken+`"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		var got DaemonConfig
		h.deps.Daemon = func(_ context.Context, cfg DaemonConfig) error {
			got = cfg
			return nil
		}
		if code := h.run("run", "--config", path); code != 0 {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		if got.ConfigPath != path {
			t.Fatalf("configPath = %q, want %q", got.ConfigPath, path)
		}

		// A run with no config file at all carries no path, rather than a guess at
		// one: `verify --config /does/not/exist` fails, and Gate 1 refusing a
		// perfectly good build is how an operator learns to stop trusting it.
		bare := newHarness(t)
		bare.deps.Daemon = func(_ context.Context, cfg DaemonConfig) error {
			got = cfg
			return nil
		}
		if code := bare.run("run", "--server", "pdmux.example.com", "--token", commandToken); code != 0 {
			t.Fatalf("exit = %d, stderr = %s", code, bare.stderr.String())
		}
		if got.ConfigPath != "" {
			t.Fatalf("configPath = %q, want empty when no file supplied anything", got.ConfigPath)
		}
	})
}

func TestCommandSurface(t *testing.T) {
	t.Run("[TC-PDAGENT-034] refuses an unknown argument with the help text", func(t *testing.T) {
		h := newHarness(t)
		if code := h.run("--nope"); code != 2 {
			t.Fatalf("exit = %d, want 2", code)
		}
		if !strings.Contains(h.stderr.String(), "Unknown argument(s): --nope") {
			t.Fatalf("stderr = %s", h.stderr.String())
		}
		// The help goes to STDERR here: this is a failure, and a script capturing
		// stdout must not receive a help screen where it expected output.
		if !strings.Contains(h.stderr.String(), "pdmux-agent run") {
			t.Fatalf("stderr = %s", h.stderr.String())
		}
		if h.stdout.Len() != 0 {
			t.Fatalf("stdout = %s", h.stdout.String())
		}
	})

	t.Run("[TC-PDAGENT-034] prints the version and the help on request", func(t *testing.T) {
		h := newHarness(t)
		if code := h.run("--version"); code != 0 {
			t.Fatalf("exit = %d", code)
		}
		if strings.TrimSpace(h.stdout.String()) != AgentVersion {
			t.Fatalf("stdout = %q", h.stdout.String())
		}
		help := newHarness(t)
		if code := help.run(); code != 0 {
			t.Fatalf("exit = %d", code)
		}
		if !strings.Contains(help.stdout.String(), "pdmux-agent verify") {
			t.Fatalf("stdout = %s", help.stdout.String())
		}
	})
}

func TestServiceUser(t *testing.T) {
	t.Run("runs a system unit as the human who ran sudo, not as root", func(t *testing.T) {
		if got := ServiceUser(map[string]string{"SUDO_USER": "dev"}, "root"); got != "dev" {
			t.Fatalf("service user = %q", got)
		}
		if got := ServiceUser(map[string]string{}, "dev"); got != "dev" {
			t.Fatalf("service user = %q", got)
		}
		// `sudo -u root` (or a root login shell) leaves nothing better to pick.
		if got := ServiceUser(map[string]string{"SUDO_USER": "root"}, "root"); got != "root" {
			t.Fatalf("service user = %q", got)
		}
	})
}

package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

// The token a real config file on the machine would be holding. Nothing this
// command does may read it into anything it prints.
const instancesToken = "pdmxa-instances-token-value"

// machine is a whole host inside t.TempDir(): both config directories, all four
// service directories and both state roots.
//
// ⚠ THE SYSTEM HALF HAS TO BE FAKED. It lives under /etc, /Library and /var/lib,
// and a spec that read those would be asserting things about whichever machine
// happens to run it — including, on a developer's box, a live agent's.
type machine struct {
	t     *testing.T
	root  string
	roots InstanceRoots
	now   time.Time
}

func newMachine(t *testing.T) *machine {
	t.Helper()
	root := t.TempDir()
	at := func(parts ...string) string {
		return filepath.Join(append([]string{root}, parts...)...)
	}
	return &machine{
		t:    t,
		root: root,
		roots: InstanceRoots{
			UserConfig:    at("home", ".config", "pdmux"),
			SystemConfig:  at("etc", "pdmux"),
			UserSystemd:   at("home", ".config", "systemd", "user"),
			SystemSystemd: at("etc", "systemd", "system"),
			UserLaunchd:   at("home", "Library", "LaunchAgents"),
			SystemLaunchd: at("Library", "LaunchDaemons"),
			UserState:     at("home", ".local", "state", "pdmux"),
			SystemState:   at("var", "lib", "pdmux"),
		},
		now: time.Unix(1_785_600_000, 0),
	}
}

func (m *machine) write(path, content string) {
	m.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		m.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		m.t.Fatal(err)
	}
}

// installConfig writes what `install` writes — including the token, because the
// point is that the scan does not read it.
func (m *machine) installConfig(dir, instance, server string) {
	m.t.Helper()
	in := InstallInput{Instance: instance}
	document := map[string]string{"server": server, "token": instancesToken}
	encoded, err := json.Marshal(document)
	if err != nil {
		m.t.Fatal(err)
	}
	m.write(filepath.Join(dir, filepath.Base(ConfigPathFor(in))), string(encoded))
}

func (m *machine) installUnit(dir, instance string) {
	m.t.Helper()
	m.write(filepath.Join(dir, UnitNameFor(InstallInput{Instance: instance})), "[Unit]\n")
}

func (m *machine) installPlist(dir, instance string) {
	m.t.Helper()
	m.write(filepath.Join(dir, PlistNameFor(InstallInput{Instance: instance})), "<plist/>\n")
}

// link writes the breadcrumb the agent would have left in that instance's state
// directory.
func (m *machine) link(root, instance string, link state.Link) {
	m.t.Helper()
	encoded, err := json.Marshal(link)
	if err != nil {
		m.t.Fatal(err)
	}
	m.write(filepath.Join(instanceStateUnder(root, instance), state.LinkFile), string(encoded))
}

func (m *machine) scan() []Instance {
	return ScanInstances(InstancesInput{Roots: m.roots, Now: m.now})
}

func find(t *testing.T, instances []Instance, name string, user bool) Instance {
	t.Helper()
	for _, row := range instances {
		if row.Name == name && row.User == user {
			return row
		}
	}
	t.Fatalf("no instance %q (user=%v) in %+v", name, user, instances)
	return Instance{}
}

func hasFinding(row Instance, fragment string) bool {
	for _, finding := range row.Findings {
		if strings.Contains(finding, fragment) {
			return true
		}
	}
	return false
}

func TestScanInstances(t *testing.T) {
	t.Run("[TC-PDAGENT-118] merges config, service and state into one row per install", func(t *testing.T) {
		m := newMachine(t)
		m.installConfig(m.roots.UserConfig, "", "https://pdmux.example.com")
		m.installUnit(m.roots.UserSystemd, "")
		m.link(m.roots.UserState, "", state.Link{
			Server:          "wss://pdmux.example.com/agent/ws",
			HostID:          "host-abc",
			LastConnectedAt: m.now.Add(-time.Minute).Unix(),
		})

		instances := m.scan()
		if len(instances) != 1 {
			t.Fatalf("three sources describing ONE install produced %d rows: %+v", len(instances), instances)
		}
		row := instances[0]
		if !row.OK {
			t.Fatalf("a complete, recently accepted install was flagged: %v", row.Findings)
		}
		if row.Server != "https://pdmux.example.com" {
			t.Fatalf("server = %q", row.Server)
		}
		if row.Platform != PlatformSystemd || row.UnitPath == "" {
			t.Fatalf("the unit did not reach the row: %+v", row)
		}
		if row.Link == nil || row.Link.HostID != "host-abc" {
			t.Fatalf("the breadcrumb did not reach the row: %+v", row)
		}
	})

	t.Run("[TC-PDAGENT-118] flags a config with no unit and a unit with no config", func(t *testing.T) {
		// The two halves of a broken install, and neither shows up anywhere else: a
		// hand-started agent works until the machine reboots, and a half-removed one
		// restarts forever against a credential that is not there.
		m := newMachine(t)
		m.installConfig(m.roots.UserConfig, "orphan", "https://pdmux.example.com")
		m.installUnit(m.roots.UserSystemd, "ghost")

		instances := m.scan()
		orphan := find(t, instances, "orphan", true)
		if !hasFinding(orphan, "no service unit") {
			t.Fatalf("a config with no unit was not flagged: %+v", orphan)
		}
		ghost := find(t, instances, "ghost", true)
		if !hasFinding(ghost, "no config file") {
			t.Fatalf("a unit with no config was not flagged: %+v", ghost)
		}
		if ghost.Server != "" {
			t.Fatalf("a row with no config claimed a server: %q", ghost.Server)
		}
	})

	t.Run("[TC-PDAGENT-118] flags an agent that has never been accepted, and one refused since", func(t *testing.T) {
		m := newMachine(t)
		// Installed completely and never welcomed: the host this whole change exists
		// for. It is invisible on the dashboard because it never arrived.
		m.installConfig(m.roots.UserConfig, "", "https://pdmux.example.com")
		m.installUnit(m.roots.UserSystemd, "")

		// Enrolled once, then refused — and still refused now.
		m.installConfig(m.roots.UserConfig, "test2", "https://dev.example.com")
		m.installUnit(m.roots.UserSystemd, "test2")
		m.link(m.roots.UserState, "test2", state.Link{
			Server:          "wss://dev.example.com/agent/ws",
			HostID:          "host-def",
			LastConnectedAt: m.now.Add(-2 * time.Hour).Unix(),
			LastRefusal:     &state.Refusal{Code: "host_deleted", At: m.now.Add(-time.Hour).Unix()},
		})

		instances := m.scan()
		never := find(t, instances, "", true)
		// ⚠ THE WORDING IS THE ASSERTION, not just the flag. An agent installed
		// before this command existed has no breadcrumb either and is perfectly
		// healthy — measured on the machine this was built on, where the live agent
		// was reported as never accepted. So the line must describe the EVIDENCE
		// ("no record") and offer the innocent reading, never state the conclusion.
		if !hasFinding(never, "no record of being accepted") {
			t.Fatalf("an agent with no breadcrumb was not flagged: %+v", never)
		}
		if hasFinding(never, "never accepted by a server") {
			t.Fatalf("the verdict states a conclusion the evidence does not support: %+v", never)
		}
		refused := find(t, instances, "test2", true)
		if !hasFinding(refused, "refused since it last connected: host_deleted") {
			t.Fatalf("a refusal newer than the last acceptance was not flagged: %+v", refused)
		}
		// It HAS connected before, so it must not also claim it never did — that is
		// the distinction the two timestamps exist to preserve.
		if hasFinding(refused, "no record of being accepted") {
			t.Fatalf("a host that was accepted two hours ago is reported as never accepted: %+v", refused)
		}
	})

	t.Run("[TC-PDAGENT-118] flags an install nobody has watched in a week", func(t *testing.T) {
		m := newMachine(t)
		m.installConfig(m.roots.SystemConfig, "", "https://pdmux.example.com")
		m.installUnit(m.roots.SystemSystemd, "")
		m.link(m.roots.SystemState, "", state.Link{
			Server:          "wss://pdmux.example.com/agent/ws",
			HostID:          "host-abc",
			LastConnectedAt: m.now.Add(-31 * 24 * time.Hour).Unix(),
		})

		row := find(t, m.scan(), "", false)
		if !hasFinding(row, "last accepted 31d ago") {
			t.Fatalf("a month-old acceptance was not flagged: %+v", row)
		}
		// And a fresh one is not flagged, or the finding says nothing.
		m.link(m.roots.SystemState, "", state.Link{
			Server:          "wss://pdmux.example.com/agent/ws",
			HostID:          "host-abc",
			LastConnectedAt: m.now.Add(-time.Hour).Unix(),
		})
		if row := find(t, m.scan(), "", false); !row.OK {
			t.Fatalf("a complete, recently accepted install was flagged: %v", row.Findings)
		}
	})

	t.Run("[TC-PDAGENT-118] keeps a user install and a system install of the same name apart", func(t *testing.T) {
		// Two agents, not one: different config, different unit, different state.
		m := newMachine(t)
		m.installConfig(m.roots.UserConfig, "", "https://dev.example.com")
		m.installPlist(m.roots.UserLaunchd, "")
		m.installConfig(m.roots.SystemConfig, "", "https://pdmux.example.com")
		m.installPlist(m.roots.SystemLaunchd, "")

		instances := m.scan()
		if len(instances) != 2 {
			t.Fatalf("two installs collapsed into %d row(s): %+v", len(instances), instances)
		}
		if got := find(t, instances, "", true).Server; got != "https://dev.example.com" {
			t.Fatalf("user row server = %q", got)
		}
		if got := find(t, instances, "", false).Server; got != "https://pdmux.example.com" {
			t.Fatalf("system row server = %q", got)
		}
		// Both service managers are scanned whatever this build's GOOS is, so a
		// launchd plist is found from a Linux test run.
		if got := find(t, instances, "", true).Platform; got != PlatformLaunchd {
			t.Fatalf("platform = %q, want launchd", got)
		}
	})

	t.Run("[TC-PDAGENT-118] finds a default install's state where the RUNTIME put it", func(t *testing.T) {
		// ⚠ A default install carries no PDMUX_STATE_DIR on purpose, so
		// internal/state decides at run time by probing /var/lib/pdmux. A per-user
		// agent on a machine that has one writes there — and looking only where this
		// scope would put it reports "never connected" for an agent that connects
		// every five seconds.
		m := newMachine(t)
		m.installConfig(m.roots.UserConfig, "", "https://pdmux.example.com")
		m.installUnit(m.roots.UserSystemd, "")
		m.link(m.roots.SystemState, "", state.Link{
			Server:          "wss://pdmux.example.com/agent/ws",
			HostID:          "host-abc",
			LastConnectedAt: m.now.Add(-time.Minute).Unix(),
		})

		row := find(t, m.scan(), "", true)
		if row.Link == nil {
			t.Fatalf("the breadcrumb in the system state root was not found: %+v", row)
		}
		if !row.OK {
			t.Fatalf("a healthy user install was flagged: %v", row.Findings)
		}
	})

	t.Run("[TC-PDAGENT-118] ignores files this installer did not write", func(t *testing.T) {
		m := newMachine(t)
		m.write(filepath.Join(m.roots.UserConfig, "agent-Foo.json"), `{"server":"https://nope.example.com"}`)
		m.write(filepath.Join(m.roots.UserConfig, "agent.json.bak"), `{"server":"https://nope.example.com"}`)
		m.write(filepath.Join(m.roots.UserSystemd, "unrelated.service"), "[Unit]\n")
		if instances := m.scan(); len(instances) != 0 {
			t.Fatalf("a stray file was reported as an install: %+v", instances)
		}
	})

	t.Run("[TC-PDAGENT-118] never reads the token out of a config file", func(t *testing.T) {
		// ⚠ This output is what people paste into an issue. The scan decodes the
		// config into a struct with one field, so the credential is dropped by the
		// parser rather than by somebody remembering not to print it.
		m := newMachine(t)
		m.installConfig(m.roots.UserConfig, "", "https://pdmux.example.com")
		m.installUnit(m.roots.UserSystemd, "")
		instances := m.scan()

		rendered := FormatInstances(instances)
		if strings.Contains(rendered, instancesToken) {
			t.Fatalf("the table leaked the token:\n%s", rendered)
		}
		encoded, err := InstancesJSON(instances)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(encoded, instancesToken) {
			t.Fatalf("--json leaked the token:\n%s", encoded)
		}
		// The assertions above prove nothing if the config was never read at all.
		if !strings.Contains(rendered, "https://pdmux.example.com") {
			t.Fatalf("the server never reached the report:\n%s", rendered)
		}
	})
}

func TestFormatInstances(t *testing.T) {
	t.Run("[TC-PDAGENT-118] renders the table in the shape doctor's report has", func(t *testing.T) {
		m := newMachine(t)
		m.installConfig(m.roots.UserConfig, "", "https://pdmux.example.com")
		m.installUnit(m.roots.UserSystemd, "")
		m.link(m.roots.UserState, "", state.Link{
			Server:          "wss://pdmux.example.com/agent/ws",
			HostID:          "host-abc",
			LastConnectedAt: m.now.Add(-time.Minute).Unix(),
		})
		m.installConfig(m.roots.UserConfig, "test2", "https://dev.example.com")

		rendered := FormatInstances(m.scan())
		for _, want := range []string{
			"OK    default (user)",
			"WARN  test2 (user)",
			"no service unit",
			"1 of 2 instance(s) need attention.",
		} {
			if !strings.Contains(rendered, want) {
				t.Fatalf("the report is missing %q:\n%s", want, rendered)
			}
		}
	})

	t.Run("[TC-PDAGENT-118] says so plainly when nothing is installed", func(t *testing.T) {
		if rendered := FormatInstances(newMachine(t).scan()); !strings.Contains(rendered, "No pdmux agent is installed here.") {
			t.Fatalf("report:\n%s", rendered)
		}
		// `[]`, not `null`: a consumer that iterates must not special-case it.
		encoded, err := InstancesJSON(nil)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(encoded, `"instances": []`) {
			t.Fatalf("json:\n%s", encoded)
		}
	})
}

func TestCommandInstances(t *testing.T) {
	t.Run("[TC-PDAGENT-118] enumerates rather than checks, so a finding is not an error", func(t *testing.T) {
		// ⚠ Deliberately unlike `doctor`. A freshly installed agent that has not
		// started yet legitimately has no breadcrumb, and an exit code that called
		// that a failure would make the command useless inside the install script
		// that just wrote the files.
		h := newHarness(t)
		if code := h.run("install", "--server", "https://pdmux.example.com", "--token", commandToken, "--user"); code != 0 {
			t.Fatalf("install exit = %d, stderr = %s", code, h.stderr.String())
		}
		h.stdout.Reset()

		if code := h.run("instances", "--json"); code != exitOK {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		var document struct {
			Instances []Instance `json:"instances"`
		}
		if err := json.Unmarshal(h.stdout.Bytes(), &document); err != nil {
			t.Fatalf("--json is not JSON: %v\n%s", err, h.stdout.String())
		}
		var installed *Instance
		for index := range document.Instances {
			if document.Instances[index].ConfigPath == filepath.Join(h.home, ".config", "pdmux", "agent.json") {
				installed = &document.Instances[index]
			}
		}
		if installed == nil {
			t.Fatalf("the install this test just performed was not listed:\n%s", h.stdout.String())
		}
		if installed.Server != "https://pdmux.example.com" {
			t.Fatalf("server = %q", installed.Server)
		}
		// The unit `install` just wrote is found through the same scan — the config
		// and the service halves really are merged, end to end. (What the VERDICT is
		// belongs to the hermetic specs above: this one runs against the real system
		// directories for its second scope, so it asserts only what it owns.)
		if installed.UnitPath != filepath.Join(h.home, ".config", "systemd", "user", "pdmux-agent.service") {
			t.Fatalf("unitPath = %q", installed.UnitPath)
		}
		if strings.Contains(h.stdout.String(), commandToken) {
			t.Fatalf("--json leaked the token:\n%s", h.stdout.String())
		}
	})

	t.Run("[TC-PDAGENT-118] is a command, not an unknown argument", func(t *testing.T) {
		// A Command const without a branch in isCommand() lands in Args.Unknown and
		// exits 2 — a command that exists everywhere except at run time.
		h := newHarness(t)
		if code := h.run("instances"); code != exitOK {
			t.Fatalf("exit = %d, stderr = %s", code, h.stderr.String())
		}
		if strings.Contains(h.stderr.String(), "Unknown argument") {
			t.Fatalf("stderr: %s", h.stderr.String())
		}
		if !strings.Contains(HelpText, "instances") {
			t.Fatal("the help text does not mention the command")
		}
	})
}

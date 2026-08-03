package cli

import (
	"path/filepath"
	"strings"
	"testing"
)

// userInstall is the shape a developer actually uses for a second agent: a
// per-user unit, because a spare agent on somebody's laptop has no business
// being a system daemon.
func userInstall() InstallInput {
	in := systemInstall()
	in.User = true
	in.RunAs = ""
	return in
}

func macInstall() InstallInput {
	in := userInstall()
	in.GOOS = "darwin"
	in.BinaryPath = "/home/dev/.local/bin/pdmux-agent"
	return in
}

func TestInstanceSeparation(t *testing.T) {
	t.Run("[TC-PDAGENT-111] every installed path splits, and none of them collide", func(t *testing.T) {
		// The point of the flag. A second agent that shared ANY of these would take
		// the first one's place instead of sitting beside it — and the first one is
		// somebody's live dashboard.
		base := userInstall()
		named := base
		named.Instance = "test2"

		pairs := []struct {
			what        string
			left, right string
		}{
			{"config", ConfigPathFor(base), ConfigPathFor(named)},
			{"state dir", StateDirFor(base), StateDirFor(named)},
			{"unit path", UnitPathFor(base), UnitPathFor(named)},
			{"binary", BinaryNameFor(base), BinaryNameFor(named)},
		}
		for _, pair := range pairs {
			if pair.left == pair.right {
				t.Fatalf("%s is shared: %q", pair.what, pair.left)
			}
		}

		// The state directory is a subdirectory rather than a sibling, so it inherits
		// the permissions the installer already sets on the parent.
		if !strings.HasPrefix(StateDirFor(named), StateDirFor(base)) {
			t.Fatalf("state dir %q is not under %q", StateDirFor(named), StateDirFor(base))
		}
		// And the config stays in the ONE 0700 directory, as a differently-named file.
		if got, want := parentOf(ConfigPathFor(named)), parentOf(ConfigPathFor(base)); got != want {
			t.Fatalf("config directory moved: %q vs %q", got, want)
		}
	})

	t.Run("[TC-PDAGENT-111] launchd labels and log files split too", func(t *testing.T) {
		// Two jobs cannot share a label — launchd would refuse the second — and two
		// agents appending to one log file makes the log useless for the question it
		// exists to answer ("why is THIS host offline").
		base := macInstall()
		named := base
		named.Instance = "test2"

		if LaunchdLabelFor(base) == LaunchdLabelFor(named) {
			t.Fatal("launchd label is shared")
		}
		if !strings.HasPrefix(LaunchdLabelFor(named), LaunchdLabelFor(base)+".") {
			t.Fatalf("label %q does not nest under %q", LaunchdLabelFor(named), LaunchdLabelFor(base))
		}
		if logPathFor(base) == logPathFor(named) {
			t.Fatalf("log path is shared: %q", logPathFor(base))
		}
		// The plist the operator loads must carry the instance label, not the default.
		plist := RenderPlist(named, "/home/dev/.local/bin/pdmux-agent-test2", logPathFor(named))
		if !strings.Contains(plist, LaunchdLabelFor(named)) {
			t.Fatalf("plist does not carry the instance label:\n%s", plist)
		}
	})

	t.Run("[TC-PDAGENT-111] no instance means byte-for-byte what it always was", func(t *testing.T) {
		// ⚠ THE PREMISE OF THE WHOLE CHANGE. Every host already out there installed
		// without this flag, and a path that shifted would orphan its config, its
		// service and its state at once.
		in := userInstall()
		if got, want := ConfigPathFor(in), "/home/dev/.config/pdmux/agent.json"; got != want {
			t.Fatalf("config = %q, want %q", got, want)
		}
		if got, want := StateDirFor(in), "/home/dev/.local/state/pdmux"; got != want {
			t.Fatalf("state = %q, want %q", got, want)
		}
		if got, want := UnitNameFor(in), UnitName; got != want {
			t.Fatalf("unit = %q, want %q", got, want)
		}
		if got, want := LaunchdLabelFor(in), LaunchdLabel; got != want {
			t.Fatalf("label = %q, want %q", got, want)
		}
		if got, want := BinaryNameFor(in), BinaryName; got != want {
			t.Fatalf("binary = %q, want %q", got, want)
		}
		if got, want := logPathFor(macInstall()), "/home/dev/Library/Logs/pdmux-agent.log"; got != want {
			t.Fatalf("log = %q, want %q", got, want)
		}
	})
}

func TestValidateInstance(t *testing.T) {
	t.Run("[TC-PDAGENT-112] refuses anything that would leave its own directory", func(t *testing.T) {
		// The name becomes a file name, a directory, a unit file name and a launchd
		// label. Without this, one `../` walks out of all four.
		for _, name := range []string{
			"../evil", "/etc/passwd", "a/b", "a b", "Test2", "with.dot",
			"-leading", "", // an empty name is valid, but only via the zero value below
			strings.Repeat("x", 17),
			"agent",
		} {
			if name == "" {
				continue
			}
			if err := ValidateInstance(name); err == nil {
				t.Fatalf("accepted %q", name)
			}
		}
	})

	t.Run("[TC-PDAGENT-112] accepts the names a person would actually pick", func(t *testing.T) {
		for _, name := range []string{"test2", "dev", "a", "local-2", strings.Repeat("x", 16)} {
			if err := ValidateInstance(name); err != nil {
				t.Fatalf("rejected %q: %v", name, err)
			}
		}
		// No instance is the ordinary install and must never be an error.
		if err := ValidateInstance(""); err != nil {
			t.Fatalf("rejected the default install: %v", err)
		}
	})

	t.Run("[TC-PDAGENT-112] refuses the name a default install already occupies", func(t *testing.T) {
		// `agent` would produce `agent-agent.json`, which is harmless — but the
		// operator asking for it is confused about what they have, and the reserved
		// word says so instead of quietly making a third thing.
		if err := ValidateInstance(ReservedInstance); err == nil {
			t.Fatal("accepted the reserved name")
		}
	})
}

func TestInstanceUnitCarriesItsStateDir(t *testing.T) {
	t.Run("[TC-PDAGENT-113] a named systemd unit names its own state directory", func(t *testing.T) {
		// ⚠ WITHOUT THIS THE SPLIT IS COSMETIC. The agent resolves its state
		// directory by probing the filesystem, so both instances would land on the
		// same one — and that directory holds the update marker, the attempt log and
		// the update lock.
		in := userInstall()
		in.Instance = "test2"
		unit := RenderUnit(in, "/home/dev/.local/bin/pdmux-agent-test2")

		if !strings.Contains(unit, "PDMUX_STATE_DIR="+StateDirFor(in)) {
			t.Fatalf("unit does not carry its state directory:\n%s", unit)
		}
		// The credential rule is unchanged: the config PATH may be in the unit, the
		// token may not. Units are world-readable and end up in support bundles.
		if strings.Contains(unit, in.Token) {
			t.Fatalf("the token leaked into the unit:\n%s", unit)
		}
	})

	t.Run("[TC-PDAGENT-113] a named launchd job names its own state directory", func(t *testing.T) {
		in := macInstall()
		in.Instance = "test2"
		plist := RenderPlist(in, "/home/dev/.local/bin/pdmux-agent-test2", logPathFor(in))

		if !strings.Contains(plist, StateDirFor(in)) {
			t.Fatalf("plist does not carry its state directory:\n%s", plist)
		}
		if strings.Contains(plist, in.Token) {
			t.Fatalf("the token leaked into the plist:\n%s", plist)
		}
	})

	t.Run("[TC-PDAGENT-113] a default install still resolves its own, as before", func(t *testing.T) {
		// Adding the variable unconditionally would freeze a path that ResolveDir
		// currently decides at run time — including its fallback when the system
		// directory is not writable.
		unit := RenderUnit(userInstall(), "/home/dev/.local/bin/pdmux-agent")
		if strings.Contains(unit, "PDMUX_STATE_DIR") {
			t.Fatalf("a default unit pinned the state directory:\n%s", unit)
		}
	})
}

func TestInstanceNameSurvivesTheRoundTrip(t *testing.T) {
	// ⚠ THE INVERSES ARE THE ONLY WAY `instances` CAN SEE AN INSTALL. Every path
	// function derives one name from one input; nothing could go the other way, so
	// an agent that was installed and then stopped connecting was invisible. A
	// forward rule and an inverse rule stated separately stop agreeing silently —
	// by finding nothing — which is why this is a round trip rather than a table
	// of expected strings.
	t.Run("[TC-PDAGENT-117] every name this installer writes can be read back", func(t *testing.T) {
		for _, name := range []string{"", "test2", "dev", "a", "local-2", strings.Repeat("x", 16)} {
			in := userInstall()
			in.Instance = name

			if got, ok := InstanceFromConfigName(filepath.Base(ConfigPathFor(in))); !ok || got != name {
				t.Fatalf("config %q read back as (%q, %v)", ConfigPathFor(in), got, ok)
			}
			if got, ok := InstanceFromUnitName(UnitNameFor(in)); !ok || got != name {
				t.Fatalf("unit %q read back as (%q, %v)", UnitNameFor(in), got, ok)
			}
			if got, ok := InstanceFromPlistName(PlistNameFor(in)); !ok || got != name {
				t.Fatalf("plist %q read back as (%q, %v)", PlistNameFor(in), got, ok)
			}
		}
	})

	t.Run("[TC-PDAGENT-117] refuses a name this installer would never have written", func(t *testing.T) {
		// A stray file is not an install, and reporting one as an install sends an
		// operator looking for a unit that never existed. The same validation the
		// forward path applies is what decides.
		for _, name := range []string{
			"agent-Foo.json", "agent-.json", "agent-../evil.json", "agent.json.bak",
			"notagent.json", "README", "agent-" + strings.Repeat("x", 17) + ".json",
		} {
			if got, ok := InstanceFromConfigName(name); ok {
				t.Fatalf("accepted %q as instance %q", name, got)
			}
		}
		for _, name := range []string{"pdmux-agent-Foo.service", "pdmux-agent.service.bak", "other.service"} {
			if got, ok := InstanceFromUnitName(name); ok {
				t.Fatalf("accepted %q as instance %q", name, got)
			}
		}
		for _, name := range []string{"dev.pdmux.agent.Foo.plist", "dev.pdmux.other.plist", "dev.pdmux.agent.plist.bak"} {
			if got, ok := InstanceFromPlistName(name); ok {
				t.Fatalf("accepted %q as instance %q", name, got)
			}
		}
	})
}

func parentOf(path string) string {
	if index := strings.LastIndex(path, "/"); index >= 0 {
		return path[:index]
	}
	return path
}

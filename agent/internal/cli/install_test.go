package cli

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The same host the TypeScript spec describes (apps/agent/test/cli.test.ts), so
// the assertions that were pinned there are pinned to the same values here.
func systemInstall() InstallInput {
	return InstallInput{
		Server:     "https://pdmux.example.com",
		Token:      "install-token-value",
		User:       false,
		Home:       "/home/dev",
		BinaryPath: "/opt/pdmux/bin/pdmux-agent",
		RunAs:      "dev",
		GOOS:       "linux",
		// The writability question has its own tests; everywhere else the answer is
		// yes, so a plan is not quietly a relocation plan.
		ExecDirWritable: func(string, string) bool { return true },
	}
}

func planOrFail(t *testing.T, in InstallInput) InstallPlan {
	t.Helper()
	plan, err := PlanInstall(in)
	if err != nil {
		t.Fatalf("PlanInstall: %v", err)
	}
	return plan
}

func findAction(t *testing.T, plan InstallPlan, path string) InstallAction {
	t.Helper()
	for _, action := range plan.Actions {
		if action.Path == path {
			return action
		}
	}
	t.Fatalf("no action touches %s (plan: %s)", path, FormatPlan(plan, true))
	return InstallAction{}
}

func TestPlanInstall(t *testing.T) {
	t.Run("[TC-PDAGENT-031] writes the config 0600 in the system location", func(t *testing.T) {
		plan := planOrFail(t, systemInstall())
		if plan.ConfigPath != "/etc/pdmux/agent.json" {
			t.Fatalf("config path = %q", plan.ConfigPath)
		}
		if plan.UnitPath != "/etc/systemd/system/pdmux-agent.service" {
			t.Fatalf("unit path = %q", plan.UnitPath)
		}
		config := findAction(t, plan, plan.ConfigPath)
		if config.Mode != 0o600 {
			t.Fatalf("config mode = %04o", config.Mode)
		}
		if !strings.Contains(config.Content, `"token": "install-token-value"`) {
			t.Fatalf("config content = %s", config.Content)
		}
		if plan.Actions[0].Kind != ActionMkdir || plan.Actions[0].Mode != 0o700 {
			t.Fatalf("first action = %+v, want the 0700 config directory", plan.Actions[0])
		}
	})

	t.Run("[TC-PDAGENT-031] switches to user paths with --user", func(t *testing.T) {
		in := systemInstall()
		in.User = true
		if got := ConfigPathFor(in); got != "/home/dev/.config/pdmux/agent.json" {
			t.Fatalf("config path = %q", got)
		}
		if got := UnitPathFor(in); got != "/home/dev/.config/systemd/user/pdmux-agent.service" {
			t.Fatalf("unit path = %q", got)
		}
		plan := planOrFail(t, in)
		if plan.NextSteps[0] != "systemctl --user daemon-reload" {
			t.Fatalf("next steps = %v", plan.NextSteps)
		}
		if !strings.Contains(findAction(t, plan, plan.UnitPath).Content, "WantedBy=default.target") {
			t.Fatal("a user unit belongs to default.target")
		}
	})

	t.Run("[TC-PDAGENT-031] renders a unit that restarts and reads the config file", func(t *testing.T) {
		unit := RenderUnit(systemInstall(), "/opt/pdmux/bin/pdmux-agent")
		for _, want := range []string{
			"ExecStart=/opt/pdmux/bin/pdmux-agent run",
			"Restart=always",
			"RestartSec=5",
			"User=dev",
			"Environment=PDMUX_CONFIG=/etc/pdmux/agent.json",
			"WantedBy=multi-user.target",
		} {
			if !strings.Contains(unit, want) {
				t.Fatalf("unit is missing %q:\n%s", want, unit)
			}
		}
		// The credential belongs in the 0600 file, never in a world-readable unit.
		if strings.Contains(unit, "install-token-value") {
			t.Fatalf("unit carries the token:\n%s", unit)
		}
	})

	t.Run("[TC-PDAGENT-032] never prints the token, in dry-run or otherwise", func(t *testing.T) {
		plan := planOrFail(t, systemInstall())
		printed := FormatPlan(plan, true)
		if strings.Contains(printed, "install-token-value") {
			t.Fatalf("dry-run printed the token:\n%s", printed)
		}
		if !strings.Contains(printed, "[dry-run] would write /etc/pdmux/agent.json (0600") {
			t.Fatalf("dry-run output:\n%s", printed)
		}
		if !strings.Contains(printed, "token=***") {
			t.Fatalf("dry-run must name the token without showing it:\n%s", printed)
		}
		if strings.Contains(FormatPlan(plan, false), "install-token-value") {
			t.Fatal("the applied plan printed the token")
		}
	})

	t.Run("[TC-PDAGENT-032] applies exactly the planned writes and modes", func(t *testing.T) {
		type record struct {
			path string
			mode fs.FileMode
		}
		var dirs, writes []record
		err := ApplyPlan(planOrFail(t, systemInstall()), InstallIO{
			Mkdir: func(path string, mode fs.FileMode, _ bool) error {
				dirs = append(dirs, record{path, mode})
				return nil
			},
			WriteFile: func(path, _ string, mode fs.FileMode) error {
				writes = append(writes, record{path, mode})
				return nil
			},
			CopyFile: func(_, dest string, _ fs.FileMode) error {
				t.Fatalf("nothing should be copied for a writable install dir, got %s", dest)
				return nil
			},
			Chown: func(string, string, string) error { return nil },
		})
		if err != nil {
			t.Fatalf("ApplyPlan: %v", err)
		}
		wantDirs := []record{
			{"/etc/pdmux", 0o700},
			{"/etc/systemd/system", 0o755},
			{"/var/lib/pdmux", 0o700},
		}
		if len(dirs) != len(wantDirs) {
			t.Fatalf("directories = %v", dirs)
		}
		for i, want := range wantDirs {
			if dirs[i] != want {
				t.Fatalf("directory %d = %v, want %v", i, dirs[i], want)
			}
		}
		wantWrites := []record{
			{"/etc/pdmux/agent.json", 0o600},
			{"/etc/systemd/system/pdmux-agent.service", 0o644},
		}
		if len(writes) != len(wantWrites) {
			t.Fatalf("writes = %v", writes)
		}
		for i, want := range wantWrites {
			if writes[i] != want {
				t.Fatalf("write %d = %v, want %v", i, writes[i], want)
			}
		}
	})

	t.Run("[TC-PDAGENT-032] leaves an existing config file at 0600, not at whatever it was", func(t *testing.T) {
		// os.WriteFile's perm applies only on create, so a config file left behind
		// at 0644 by an earlier release (or by a careless umask) would keep exposing
		// the credential while the plan claimed 0600.
		home := t.TempDir()
		in := systemInstall()
		in.User = true
		in.Home = home
		configPath := ConfigPathFor(in)
		if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(configPath, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := ApplyPlan(planOrFail(t, in), DefaultInstallIO()); err != nil {
			t.Fatalf("ApplyPlan: %v", err)
		}
		info, err := os.Stat(configPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("config mode = %04o, want 0600", info.Mode().Perm())
		}
		if dir, err := os.Stat(filepath.Dir(configPath)); err != nil || dir.Mode().Perm() != 0o700 {
			t.Fatalf("config directory mode = %v (%v), want 0700", dir.Mode().Perm(), err)
		}
	})
}

// ---------------------------------------------------------------------------
// New in the Go agent — untagged until the traceability matrix declares TC ids
// for them (the launchd branch, the state directory, and the writability of the
// ExecStart path).
// ---------------------------------------------------------------------------

func TestPlanInstallStateDirectory(t *testing.T) {
	t.Run("creates the state directory a system unit cannot create for itself", func(t *testing.T) {
		plan := planOrFail(t, systemInstall())
		if plan.StateDir != "/var/lib/pdmux" {
			t.Fatalf("state dir = %q", plan.StateDir)
		}
		action := findAction(t, plan, plan.StateDir)
		if action.Kind != ActionMkdir || action.Mode != 0o700 {
			t.Fatalf("state dir action = %+v", action)
		}
		// Owned by the service user, or the daemon cannot write the ledger into the
		// directory the installer just made for it.
		if action.Owner != "dev" {
			t.Fatalf("state dir owner = %q, want the service user", action.Owner)
		}
		if !action.EnforceMode {
			t.Fatal("the state directory's mode must be enforced — it names repository paths")
		}
	})

	t.Run("keeps a user install's state inside the home directory", func(t *testing.T) {
		in := systemInstall()
		in.User = true
		plan := planOrFail(t, in)
		if plan.StateDir != "/home/dev/.local/state/pdmux" {
			t.Fatalf("state dir = %q", plan.StateDir)
		}
		if owner := findAction(t, plan, plan.StateDir).Owner; owner != "" {
			t.Fatalf("a user install chowns nothing, got %q", owner)
		}
	})
}

func TestPlanInstallStartLimit(t *testing.T) {
	t.Run("disables the systemd start limit that would need a human to clear", func(t *testing.T) {
		unit := RenderUnit(systemInstall(), "/opt/pdmux/bin/pdmux-agent")
		if !strings.Contains(unit, "StartLimitIntervalSec=0") {
			t.Fatalf("unit would give up after five restarts:\n%s", unit)
		}
	})
}

func TestPlanInstallLaunchd(t *testing.T) {
	darwin := func(user bool) InstallInput {
		in := systemInstall()
		in.GOOS = "darwin"
		in.User = user
		in.Home = "/Users/dev"
		in.BinaryPath = "/usr/local/bin/pdmux-agent"
		return in
	}

	t.Run("writes a launchd daemon instead of a systemd unit", func(t *testing.T) {
		plan := planOrFail(t, darwin(false))
		if plan.Platform != PlatformLaunchd {
			t.Fatalf("platform = %q", plan.Platform)
		}
		if plan.UnitPath != "/Library/LaunchDaemons/dev.pdmux.agent.plist" {
			t.Fatalf("unit path = %q", plan.UnitPath)
		}
		plist := findAction(t, plan, plan.UnitPath)
		if plist.Owner != "root" || plist.Group != "wheel" {
			// launchd refuses to load a daemon plist that is not root:wheel.
			t.Fatalf("plist ownership = %s:%s", plist.Owner, plist.Group)
		}
		for _, want := range []string{
			"<key>Label</key>\n  <string>dev.pdmux.agent</string>",
			"<string>/usr/local/bin/pdmux-agent</string>",
			"<string>run</string>",
			"<key>RunAtLoad</key>\n  <true/>",
			"<key>KeepAlive</key>\n  <true/>",
			"<key>ThrottleInterval</key>\n  <integer>5</integer>",
			"<key>ProcessType</key>\n  <string>Background</string>",
			"<key>StandardOutPath</key>\n  <string>/var/log/pdmux/agent.log</string>",
			"<key>StandardErrorPath</key>\n  <string>/var/log/pdmux/agent.log</string>",
			"<key>PDMUX_CONFIG</key>\n    <string>/etc/pdmux/agent.json</string>",
			// A LaunchDaemon runs as root unless it says otherwise; this one has no
			// business doing that.
			"<key>UserName</key>\n  <string>dev</string>",
		} {
			if !strings.Contains(plist.Content, want) {
				t.Fatalf("plist is missing %q:\n%s", want, plist.Content)
			}
		}
		if strings.Contains(plist.Content, "install-token-value") {
			t.Fatalf("plist carries the token:\n%s", plist.Content)
		}
		// launchd has no journald, so the log directory has to exist first.
		if action := findAction(t, plan, "/var/log/pdmux"); action.Owner != "dev" {
			t.Fatalf("log directory = %+v", action)
		}
		if plan.NextSteps[0] != "sudo launchctl bootstrap system /Library/LaunchDaemons/dev.pdmux.agent.plist" {
			t.Fatalf("next steps = %v", plan.NextSteps)
		}
	})

	t.Run("puts a user agent under the home directory and never says systemctl", func(t *testing.T) {
		plan := planOrFail(t, darwin(true))
		if plan.UnitPath != "/Users/dev/Library/LaunchAgents/dev.pdmux.agent.plist" {
			t.Fatalf("unit path = %q", plan.UnitPath)
		}
		plist := findAction(t, plan, plan.UnitPath)
		if strings.Contains(plist.Content, "UserName") {
			t.Fatal("a LaunchAgent already runs as the user who loaded it")
		}
		if !strings.Contains(plist.Content, "/Users/dev/Library/Logs/pdmux-agent.log") {
			t.Fatalf("plist logs nowhere useful:\n%s", plist.Content)
		}
		for _, step := range plan.NextSteps {
			if strings.Contains(step, "systemctl") {
				t.Fatalf("macOS instructions must not name systemctl: %q", step)
			}
			if !strings.Contains(step, "launchctl") {
				t.Fatalf("next step %q does not use launchctl", step)
			}
		}
	})

	t.Run("refuses an OS with neither systemd nor launchd", func(t *testing.T) {
		in := systemInstall()
		in.GOOS = "windows"
		_, err := PlanInstall(in)
		if err == nil {
			t.Fatal("a systemd unit on a host with no systemd is a file nothing will ever read")
		}
		if !strings.Contains(err.Error(), "windows") {
			t.Fatalf("the refusal must name the host: %v", err)
		}
	})

	t.Run("escapes a path that would otherwise break the plist", func(t *testing.T) {
		in := darwin(true)
		in.Home = "/Users/a&b"
		plist := RenderPlist(in, "/Users/a&b/bin/pdmux-agent", logPathFor(in))
		if strings.Contains(plist, "a&b<") || strings.Contains(plist, "<string>/Users/a&b/bin") {
			t.Fatalf("unescaped ampersand makes launchd reject the job:\n%s", plist)
		}
		if !strings.Contains(plist, "/Users/a&amp;b/bin/pdmux-agent") {
			t.Fatalf("plist:\n%s", plist)
		}
	})
}

func TestPlanInstallExecStartWritability(t *testing.T) {
	t.Run("relocates the binary when the service user cannot replace it", func(t *testing.T) {
		in := systemInstall()
		in.BinaryPath = "/usr/local/bin/pdmux-agent"
		in.ExecDirWritable = func(dir, serviceUser string) bool {
			if dir != "/usr/local/bin" || serviceUser != "dev" {
				t.Fatalf("asked about %q for %q", dir, serviceUser)
			}
			return false
		}
		plan := planOrFail(t, in)
		if plan.ExecPath != "/opt/pdmux/bin/pdmux-agent" {
			t.Fatalf("exec path = %q", plan.ExecPath)
		}
		copied := findAction(t, plan, plan.ExecPath)
		if copied.Kind != ActionCopy || copied.Source != "/usr/local/bin/pdmux-agent" || copied.Owner != "dev" {
			t.Fatalf("copy action = %+v", copied)
		}
		if !strings.Contains(findAction(t, plan, plan.UnitPath).Content, "ExecStart=/opt/pdmux/bin/pdmux-agent run") {
			t.Fatal("the unit must start the copy, not the original")
		}
		// Nothing here is silent: the plan says what moved and why.
		if len(plan.Notes) != 1 || !strings.Contains(plan.Notes[0], "/opt/pdmux/bin/pdmux-agent") {
			t.Fatalf("notes = %v", plan.Notes)
		}
		if !strings.Contains(FormatPlan(plan, true), "Note:") {
			t.Fatalf("the note must be printed:\n%s", FormatPlan(plan, true))
		}
	})

	t.Run("says what to chown when the binary is already where it belongs", func(t *testing.T) {
		in := systemInstall() // BinaryPath is already /opt/pdmux/bin/pdmux-agent
		in.ExecDirWritable = func(string, string) bool { return false }
		plan := planOrFail(t, in)
		if plan.ExecPath != "/opt/pdmux/bin/pdmux-agent" {
			t.Fatalf("exec path = %q", plan.ExecPath)
		}
		for _, action := range plan.Actions {
			if action.Kind == ActionCopy {
				t.Fatal("a binary must never be copied onto itself")
			}
		}
		if len(plan.Notes) != 1 || !strings.Contains(plan.Notes[0], "chown") {
			t.Fatalf("notes = %v, want the exact command to run", plan.Notes)
		}
	})

	t.Run("leaves a writable location alone", func(t *testing.T) {
		plan := planOrFail(t, systemInstall())
		if plan.ExecPath != "/opt/pdmux/bin/pdmux-agent" || len(plan.Notes) != 0 {
			t.Fatalf("exec = %q, notes = %v", plan.ExecPath, plan.Notes)
		}
	})

	t.Run("copies through a rename so a running binary can be replaced", func(t *testing.T) {
		dir := t.TempDir()
		source := filepath.Join(dir, "source")
		dest := filepath.Join(dir, "dest")
		if err := os.WriteFile(source, []byte("#!/bin/true\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dest, []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := DefaultInstallIO().CopyFile(source, dest, 0o755); err != nil {
			t.Fatalf("CopyFile: %v", err)
		}
		data, err := os.ReadFile(dest)
		if err != nil || string(data) != "#!/bin/true\n" {
			t.Fatalf("dest = %q (%v)", data, err)
		}
		info, err := os.Stat(dest)
		if err != nil || info.Mode().Perm() != 0o755 {
			t.Fatalf("dest mode = %v (%v)", info.Mode().Perm(), err)
		}
		if _, err := os.Stat(dest + ".new"); !os.IsNotExist(err) {
			t.Fatal("the temporary file must not survive a successful copy")
		}
	})
}

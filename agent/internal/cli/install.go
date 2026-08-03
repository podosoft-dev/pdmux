// `pdmux-agent install` — write the config file and a service unit.
//
// The command is a PLANNER plus an applier. Everything that decides paths, modes
// and file contents is pure, so a spec can assert that the config is written 0600
// and that the printed plan never contains the token — without a root-owned /etc
// anywhere near the test run.
//
// It deliberately does NOT run `systemctl` (or `launchctl`): enabling a unit needs
// privileges the installer may not have, and a half-applied install that already
// claimed success is worse than printing two commands for a human to paste.
//
// Ported from apps/agent/src/cli/install.ts, with four changes the Go agent needs:
//
//  1. LAUNCHD. The TypeScript wrote systemd units unconditionally — on macOS it
//     would happily drop a unit in ~/.config/systemd/user and print `systemctl
//     --user` commands that do not exist on that machine. A single static binary
//     is exactly what makes macOS hosts practical, so the plist is a real branch
//     and an OS with neither service manager is REFUSED rather than handed a unit
//     nothing will ever load.
//  2. StartLimitIntervalSec=0 (see renderUnit).
//  3. The state directory is created here (see stateDirAction).
//  4. The ExecStart path is checked for writability by the service user (see
//     placeExec).
package cli

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
	"github.com/podosoft-dev/pdmux/agent/internal/update"
)

// Names of the things this writes. They are part of the operator's vocabulary
// (`systemctl status pdmux-agent`, `launchctl print system/dev.pdmux.agent`), so
// renaming one is a breaking change for every host already installed.
const (
	UnitName     = "pdmux-agent.service"
	LaunchdLabel = "dev.pdmux.agent"
	PlistName    = LaunchdLabel + ".plist"
	// BinaryName is what the binary is called wherever this installer puts it.
	BinaryName = "pdmux-agent"
)

// InstancePattern is what an instance name may contain.
//
// ⚠ IT IS VALIDATED BECAUSE THE NAME BECOMES A PATH. It ends up in a config file
// name, a state directory, a unit file name and a launchd label — so without this
// a single `../` walks out of every one of them, and a space or a slash produces a
// unit file no service manager will load. Sixteen characters is generous for what
// it is for (telling two agents on one machine apart) and short enough that the
// systemd unit name stays readable in `systemctl status`.
var InstancePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,15}$`)

// ReservedInstance is the name a default install already occupies. Allowing it
// would produce exactly the files this flag exists to keep apart.
const ReservedInstance = "agent"

// ValidateInstance answers whether a name may be installed under.
//
// An empty name is the ordinary install and is always valid — that is what makes
// this change invisible to every host already out there.
func ValidateInstance(name string) error {
	if name == "" {
		return nil
	}
	if !InstancePattern.MatchString(name) {
		return fmt.Errorf("instance %q must match %s", name, InstancePattern)
	}
	if name == ReservedInstance {
		return fmt.Errorf("instance %q is reserved: it is what a default install is already called", name)
	}
	return nil
}

// suffixed appends `-<instance>` to a name, before its extension.
func suffixed(base, ext, instance string) string {
	if instance == "" {
		return base + ext
	}
	return base + "-" + instance + ext
}

// unsuffixed is the inverse: given a file name this installer would have
// written, it answers which instance wrote it.
//
// ⚠ THE INVERSES LIVE BESIDE THE FORWARD FUNCTIONS BECAUSE THEY CANNOT BE
// ALLOWED TO DRIFT. `pdmux-agent instances` has to turn a name back into an
// instance to enumerate what is installed here, and a naming rule stated twice
// in two files stops agreeing the first time one of them changes — silently, by
// finding nothing.
//
// ok is false when the name was not produced by suffixed at all, and also when
// the instance part is not one this installer would have ACCEPTED: a stray
// `agent-Foo.json` somebody dropped in /etc/pdmux is not an install, and
// reporting it as one sends an operator looking for a unit that never existed.
func unsuffixed(base, ext, separator, name string) (string, bool) {
	trimmed, cut := strings.CutSuffix(name, ext)
	if !cut {
		return "", false
	}
	if trimmed == base {
		return "", true
	}
	instance, cut := strings.CutPrefix(trimmed, base+separator)
	// An empty instance here is `agent-.json`, which is not the default install
	// under another name — it is a file nothing here wrote.
	if !cut || instance == "" || ValidateInstance(instance) != nil {
		return "", false
	}
	return instance, true
}

// InstanceFromConfigName maps `agent.json` / `agent-<name>.json` back.
//
// The base name is taken from the same constant instanceConfigPath splits, so
// there is one spelling of `agent.json` between them rather than two.
func InstanceFromConfigName(name string) (string, bool) {
	file := filepath.Base(config.SystemConfigPath)
	ext := filepath.Ext(file)
	return unsuffixed(strings.TrimSuffix(file, ext), ext, "-", name)
}

// InstanceFromUnitName maps `pdmux-agent.service` / `pdmux-agent-<name>.service`.
func InstanceFromUnitName(name string) (string, bool) {
	return unsuffixed(BinaryName, ".service", "-", name)
}

// InstanceFromPlistName maps `dev.pdmux.agent.plist` /
// `dev.pdmux.agent.<name>.plist`. The separator is a DOT here, because that is
// how launchd labels nest — see LaunchdLabelFor.
func InstanceFromPlistName(name string) (string, bool) {
	return unsuffixed(LaunchdLabel, ".plist", ".", name)
}

// UnitNameFor is the systemd unit file name for this instance.
func UnitNameFor(in InstallInput) string {
	return suffixed(BinaryName, ".service", in.Instance)
}

// LaunchdLabelFor is the launchd label for this instance.
//
// Dotted rather than dashed, because that is how launchd labels nest and how
// `launchctl print gui/$(id -u)/dev.pdmux.agent.<name>` reads to an operator.
func LaunchdLabelFor(in InstallInput) string {
	if in.Instance == "" {
		return LaunchdLabel
	}
	return LaunchdLabel + "." + in.Instance
}

// PlistNameFor is the launchd plist file name for this instance.
func PlistNameFor(in InstallInput) string { return LaunchdLabelFor(in) + ".plist" }

// BinaryNameFor is what the installed binary is called.
//
// ⚠ SEPARATE PER INSTANCE BECAUSE A REMOTE UPDATE REPLACES IT. Two instances
// sharing one file means either dashboard's update silently changes the other's
// agent, and the one that did not ask finds itself on a version it never approved.
func BinaryNameFor(in InstallInput) string { return suffixed(BinaryName, "", in.Instance) }

// Where a relocated binary goes when the one being run lives somewhere the
// service user cannot write (see placeExec).
const systemExecDir = "/opt/pdmux/bin"

// Modes. The config file holds the credential and nothing else may read it; the
// unit is world-readable on purpose (launchd refuses a group- or world-writable
// plist, and systemd wants to read it as root).
const (
	configDirMode fs.FileMode = 0o700
	configMode    fs.FileMode = 0o600
	unitDirMode   fs.FileMode = 0o755
	unitMode      fs.FileMode = 0o644
	execDirMode   fs.FileMode = 0o755
	execMode      fs.FileMode = 0o755
	logDirMode    fs.FileMode = 0o755
)

// Platform is the service manager this host uses.
type Platform string

const (
	PlatformSystemd Platform = "systemd"
	PlatformLaunchd Platform = "launchd"
)

// PlatformFor maps a GOOS onto its service manager; ok is false for an OS this
// installer refuses to guess at.
func PlatformFor(goos string) (Platform, bool) {
	switch goos {
	case "linux":
		return PlatformSystemd, true
	case "darwin":
		return PlatformLaunchd, true
	default:
		return "", false
	}
}

// InstallInput is everything a plan is computed from. Nothing here is read from
// the process, so a spec describes a whole host by filling in a struct.
type InstallInput struct {
	Server string
	Token  string
	// User installs a per-user unit under Home instead of a system one.
	User bool
	// Instance names a SECOND (third, …) agent on one machine. Empty is the
	// ordinary install and produces exactly the paths it always did.
	//
	// It exists because a developer debugging locally needs an agent to point at
	// their own stack, and the machine's real agent is already spoken for — taking
	// it over would disconnect whoever is watching that dashboard, since the server
	// keeps one socket per host and the newer connection wins.
	Instance string
	Home     string
	// BinaryPath is the absolute path of the agent binary being installed —
	// normally the running executable. Unlike the TypeScript there is no
	// interpreter to name: a Go build is one file, which is the whole reason the
	// install script does not have to plant a language runtime first.
	BinaryPath string
	// RunAs is the Unix user a SYSTEM unit runs as. Empty means the unit does not
	// name one, which for systemd means root — so it is normally set.
	RunAs string
	// Hostname overrides the reported hostname; empty leaves it to the host.
	Hostname string
	// GOOS is the target platform; empty means the platform this binary was built
	// for. Injected so a spec can plan a macOS install from Linux.
	GOOS string
	// ExecDirWritable answers "can the user this service runs as create files in
	// dir". Empty serviceUser means the user running the installer. nil uses the
	// real check.
	ExecDirWritable func(dir, serviceUser string) bool
}

// ActionKind is what an action does. Chown is not a kind of its own: it is the
// Owner field on the action that creates the path, because the two must not be
// able to drift apart.
type ActionKind string

const (
	ActionMkdir ActionKind = "mkdir"
	ActionWrite ActionKind = "write"
	ActionCopy  ActionKind = "copy"
)

// InstallAction is one filesystem step.
type InstallAction struct {
	Kind ActionKind
	Path string
	Mode fs.FileMode
	// Content is set for ActionWrite, Source for ActionCopy.
	Content string
	Source  string
	// Owner/Group chown the result. Only a system install sets them, and only
	// where it matters: the service user must own what it has to write, and
	// launchd refuses to load a plist that is not root:wheel.
	Owner string
	Group string
	// EnforceMode chmods a path that already exists. Set only for the directories
	// this installer owns — widening somebody's existing ~/Library/Logs to 0755
	// because our plan happens to mention it would be a security change we were
	// never asked for.
	EnforceMode bool
	// Describe is one line for --dry-run. It never contains a credential.
	Describe string
}

// InstallPlan is the whole install, decided but not yet applied.
type InstallPlan struct {
	Platform  Platform
	Actions   []InstallAction
	NextSteps []string
	// Notes are things the operator has to know that are not a file write —
	// today, why the binary was placed somewhere other than where it was run from.
	Notes      []string
	ConfigPath string
	UnitPath   string
	// ExecPath is what the unit will start, which is not always BinaryPath.
	ExecPath string
	StateDir string
}

// ConfigPathFor is where the 0600 credential file goes.
func ConfigPathFor(in InstallInput) string {
	if in.User {
		return instanceConfigPath(config.UserConfigPath(in.Home), in.Instance)
	}
	return instanceConfigPath(config.SystemConfigPath, in.Instance)
}

// instanceConfigPath puts the instance in the FILE name, not the directory, so
// every instance's credential keeps the one 0700 directory the installer already
// creates and locks down.
func instanceConfigPath(base, instance string) string {
	if instance == "" {
		return base
	}
	dir, file := filepath.Split(base)
	ext := filepath.Ext(file)
	return filepath.Join(dir, suffixed(strings.TrimSuffix(file, ext), ext, instance))
}

// UnitPathFor is where the systemd unit or launchd plist goes. It returns an
// empty string for an OS with neither.
func UnitPathFor(in InstallInput) string {
	platform, ok := PlatformFor(in.goos())
	if !ok {
		return ""
	}
	if platform == PlatformLaunchd {
		if in.User {
			return filepath.Join(in.Home, "Library", "LaunchAgents", PlistNameFor(in))
		}
		// A system daemon: /Library, not /System/Library, which is sealed.
		return filepath.Join("/Library", "LaunchDaemons", PlistNameFor(in))
	}
	if in.User {
		return filepath.Join(in.Home, ".config", "systemd", "user", UnitNameFor(in))
	}
	return filepath.Join("/etc/systemd/system", UnitNameFor(in))
}

// StateDirFor is the directory the agent keeps its restart-persistent ledger in.
//
// It mirrors internal/state's resolution rather than calling it: ResolveDir
// answers "where is it NOW" by probing the filesystem, and an installer has to
// answer "where will it be, once I have created it" — which for a system unit is
// /var/lib/pdmux precisely because this step is what makes that path exist.
func StateDirFor(in InstallInput) string {
	return instanceStateUnder(instanceStateRoot(in), in.Instance)
}

// instanceStateUnder places an instance's state inside a root.
//
// ⚠ A SUBDIRECTORY, NOT A SUFFIX, and under `i/` so it can never collide with
// something the state directory already holds. Sharing it would mean two
// instances sharing the update marker, the attempt log and the update lock — so
// one dashboard's update would read the other's progress.
//
// It is separate from StateDirFor because `instances` has to apply the same rule
// to a root it was handed rather than to one derived from an install.
func instanceStateUnder(root, instance string) string {
	if instance == "" {
		return root
	}
	return filepath.Join(root, "i", instance)
}

func instanceStateRoot(in InstallInput) string {
	if in.User {
		return filepath.Join(in.Home, ".local", "state", "pdmux")
	}
	return state.SystemDir
}

func (in InstallInput) goos() string {
	if in.GOOS != "" {
		return in.GOOS
	}
	return runtimeGOOS
}

// serviceUser is the account the unit will run as: the named one for a system
// install, and the installing user (empty = "whoever runs this") otherwise.
func (in InstallInput) serviceUser() string {
	if in.User {
		return ""
	}
	return in.RunAs
}

// RenderConfig is the 0600 file: the credential, and nothing that is not needed
// to dial.
func RenderConfig(in InstallInput) string {
	document := struct {
		Server   string `json:"server"`
		Token    string `json:"token"`
		Hostname string `json:"hostname,omitempty"`
	}{Server: in.Server, Token: in.Token, Hostname: in.Hostname}
	// Two-space indent and a trailing newline, byte-identical to what the Node
	// installer wrote: hosts will be running both agents for a while, and a config
	// file that reformats itself on every install is a diff nobody can read.
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		// Three strings cannot fail to marshal; returning an error here would push
		// a nil check into every caller for a branch that cannot execute.
		return ""
	}
	return string(encoded) + "\n"
}

// RenderUnit is the systemd unit.
func RenderUnit(in InstallInput, execPath string) string {
	lines := []string{
		"[Unit]",
		fmt.Sprintf("Description=pdmux agent %s", AgentVersion),
		"Documentation=https://github.com/podosoft-dev/pdmux",
		"After=network-online.target",
		"Wants=network-online.target",
		// ⚠ LOAD-BEARING. systemd's default start limit gives up after 5 starts in
		// 10 seconds and leaves the unit in `failed` until a human runs
		// `systemctl reset-failed`. An agent that crashes five times quickly —
		// during a bad self-update, or against a server that is briefly wrong —
		// would therefore need someone with SSH to come back, which is the exact
		// brick the update design exists to prevent. Restart=always must mean
		// always; RestartSec=5 is what keeps that from being a busy loop.
		"StartLimitIntervalSec=0",
		"",
		"[Service]",
		"Type=simple",
		fmt.Sprintf("ExecStart=%s run", execPath),
		// The agent dials out and holds one socket; a crash must simply reconnect.
		"Restart=always",
		"RestartSec=5",
		// The credential lives in the 0600 config file, never in the unit — units
		// are world-readable and end up in support bundles.
		fmt.Sprintf("Environment=PDMUX_CONFIG=%s", ConfigPathFor(in)),
		// Says out loud that something will restart this process, which is what makes
		// a remote update possible: the agent replaces its own binary and exits, and
		// `Restart=always` above brings the new one up. Without a restart source that
		// exit is a hole the agent never climbs out of, so it refuses the update.
		//
		// ⚠ EXPLICIT, NOT INFERRED. The fallback reads `INVOCATION_ID`/`NOTIFY_SOCKET`,
		// which are true of *any* systemd-started process — including one a person ran
		// through `systemd-run` to try something out. Being wrong here strands a host.
		fmt.Sprintf("Environment=%s=service", update.EnvRestart),
	}
	// ⚠ ONLY FOR A NAMED INSTANCE, AND IT IS NOT OPTIONAL THERE. Left out, the
	// agent resolves its own state directory by probing the filesystem and every
	// instance on the machine converges on the SAME one — which is where the
	// update marker, the attempt log and the update lock live. A default install
	// keeps resolving it itself, so nothing already deployed changes.
	if in.Instance != "" {
		lines = append(lines, fmt.Sprintf("Environment=%s=%s", state.EnvStateDir, StateDirFor(in)))
	}
	if !in.User && in.RunAs != "" {
		lines = append(lines, fmt.Sprintf("User=%s", in.RunAs))
	}
	lines = append(lines, "", "[Install]")
	if in.User {
		lines = append(lines, "WantedBy=default.target")
	} else {
		lines = append(lines, "WantedBy=multi-user.target")
	}
	return strings.Join(lines, "\n") + "\n"
}

// RenderPlist is the launchd job.
//
// KeepAlive + RunAtLoad is launchd's Restart=always: start at boot (or login) and
// start again whenever it exits, for any reason. ThrottleInterval is its
// RestartSec — and unlike systemd, launchd has no start limit to disable, so
// there is no macOS equivalent of the brick StartLimitIntervalSec=0 avoids.
// ProcessType Background asks the scheduler to treat it as a daemon rather than
// as something a user is waiting on.
func RenderPlist(in InstallInput, execPath, logPath string) string {
	var body strings.Builder
	body.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	body.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` + "\n")
	body.WriteString(`<plist version="1.0">` + "\n<dict>\n")
	writePlistString(&body, "Label", LaunchdLabelFor(in))
	body.WriteString("  <key>ProgramArguments</key>\n  <array>\n")
	fmt.Fprintf(&body, "    <string>%s</string>\n", xmlEscape(execPath))
	body.WriteString("    <string>run</string>\n  </array>\n")
	body.WriteString("  <key>RunAtLoad</key>\n  <true/>\n")
	body.WriteString("  <key>KeepAlive</key>\n  <true/>\n")
	body.WriteString("  <key>ThrottleInterval</key>\n  <integer>5</integer>\n")
	writePlistString(&body, "ProcessType", "Background")
	// launchd has no journal: without these two the agent's log lines go nowhere
	// and "why is this host offline" becomes unanswerable on macOS.
	writePlistString(&body, "StandardOutPath", logPath)
	writePlistString(&body, "StandardErrorPath", logPath)
	// Same rule as the systemd unit: the config PATH may be in the job
	// description, the token may not — `launchctl print` shows this to anyone.
	body.WriteString("  <key>EnvironmentVariables</key>\n  <dict>\n")
	fmt.Fprintf(&body, "    <key>%s</key>\n    <string>%s</string>\n", config.EnvConfig, xmlEscape(ConfigPathFor(in)))
	// Same reason as the systemd unit: KeepAlive below will restart this process, and
	// saying so explicitly is what lets a remote update exit and come back. Inferring
	// it from ppid == 1 is true of more than launchd.
	fmt.Fprintf(&body, "    <key>%s</key>\n    <string>service</string>\n", update.EnvRestart)
	// Same reason as the systemd unit: without this every instance shares one
	// state directory, and with it the update lock.
	if in.Instance != "" {
		fmt.Fprintf(&body, "    <key>%s</key>\n    <string>%s</string>\n", state.EnvStateDir, xmlEscape(StateDirFor(in)))
	}
	body.WriteString("  </dict>\n")
	if !in.User && in.RunAs != "" {
		// A LaunchDaemon runs as root unless it says otherwise, and this one has no
		// reason to: it reads checkouts and opens PTYs on behalf of one human.
		writePlistString(&body, "UserName", in.RunAs)
	}
	body.WriteString("</dict>\n</plist>\n")
	return body.String()
}

func writePlistString(out *strings.Builder, key, value string) {
	fmt.Fprintf(out, "  <key>%s</key>\n  <string>%s</string>\n", xmlEscape(key), xmlEscape(value))
}

// xmlEscape keeps a path with an ampersand or an angle bracket from producing a
// plist launchd cannot parse — which fails as "the job never loaded", with no
// clue pointing at the home directory that had a `&` in it.
func xmlEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(value)
}

// logPathFor is where a launchd job's stdout/stderr go. systemd has journald and
// needs none of this.
func logPathFor(in InstallInput) string {
	if in.User {
		return filepath.Join(in.Home, "Library", "Logs", suffixed("pdmux-agent", ".log", in.Instance))
	}
	return "/var/log/pdmux/agent.log"
}

// execPlacement is the answer to "what should ExecStart name".
type execPlacement struct {
	Path string
	// CopyFrom is set when the binary has to be put at Path first.
	CopyFrom string
	Note     string
}

// placeExec makes sure the path the unit starts is one the service user can
// REPLACE, not merely execute.
//
// WHY THAT MATTERS: a later release lets the agent update itself by writing a new
// binary next to the old one and renaming it into place. Renaming needs write
// permission on the DIRECTORY, so the ordinary Linux install — binary in
// /usr/local/bin (root:root 0755) plus `User=pdmux` in the unit — makes
// self-update structurally impossible, and it fails at the last step of an update
// that already downloaded and verified a build. Detecting it here costs one stat.
//
// The resolution is never silent: either the plan shows the copy that moves the
// binary somewhere writable, or it prints exactly what the operator has to chown.
func placeExec(in InstallInput, writable func(dir, serviceUser string) bool) execPlacement {
	current := in.BinaryPath
	serviceUser := in.serviceUser()
	if current == "" {
		return execPlacement{}
	}
	if writable(filepath.Dir(current), serviceUser) {
		return execPlacement{Path: current}
	}

	destination := filepath.Join(systemExecDir, BinaryNameFor(in))
	if in.User {
		destination = filepath.Join(in.Home, ".local", "bin", BinaryNameFor(in))
	}
	who := serviceUser
	if who == "" {
		who = "the user this unit runs as"
	}
	if destination == current {
		// Already in the right place, just owned by the wrong account. Moving it
		// somewhere else would only produce a second copy nobody asked for.
		return execPlacement{
			Path: current,
			Note: fmt.Sprintf(
				"%s is not writable by %s, so a future self-update cannot replace this binary. Fix it with: chown -R %s %s",
				filepath.Dir(current), who, who, filepath.Dir(current)),
		}
	}
	return execPlacement{
		Path:     destination,
		CopyFrom: current,
		Note: fmt.Sprintf(
			"%s is not writable by %s, so the binary is installed to %s instead (a self-update replaces the file in place and needs that directory writable).",
			filepath.Dir(current), who, destination),
	}
}

// PlanInstall decides every path, mode and byte this install would write.
func PlanInstall(in InstallInput) (InstallPlan, error) {
	platform, ok := PlatformFor(in.goos())
	if !ok {
		// Refused rather than approximated: writing a systemd unit on an OS with no
		// systemd produces a file nothing will ever read, and an install that
		// reported success. Someone running a supervisor we do not know about can
		// still run `pdmux-agent run` under it.
		return InstallPlan{}, fmt.Errorf(
			"install supports linux (systemd) and macOS (launchd); this host runs %s — run `%s run` under whatever supervises services here",
			in.goos(), BinaryNameFor(in))
	}

	writable := in.ExecDirWritable
	if writable == nil {
		writable = DirWritableBy
	}
	placement := placeExec(in, writable)

	configPath := ConfigPathFor(in)
	unitPath := UnitPathFor(in)
	stateDir := StateDirFor(in)
	owner := in.serviceUser()

	actions := []InstallAction{
		mkdirAction(filepath.Dir(configPath), configDirMode, owner, "", true),
		{
			Kind:    ActionWrite,
			Path:    configPath,
			Mode:    configMode,
			Content: RenderConfig(in),
			// 0600 AND owned by the service user, or the daemon cannot read its own
			// credential: a system install runs under `User=<runAs>` while the
			// installer runs under sudo, so a file left owned by root at 0600 is
			// readable by exactly nobody who needs it.
			Owner: owner,
			// The describe line is what --dry-run prints, so it names the token
			// without showing it.
			Describe: fmt.Sprintf("write %s (%04o%s) with server=%s token=%s",
				configPath, configMode.Perm(), ownerSuffix(owner, ""), in.Server, log.Redacted),
		},
	}

	if placement.CopyFrom != "" {
		execDir := filepath.Dir(placement.Path)
		actions = append(actions,
			mkdirAction(execDir, execDirMode, owner, "", true),
			InstallAction{
				Kind:   ActionCopy,
				Path:   placement.Path,
				Source: placement.CopyFrom,
				Mode:   execMode,
				Owner:  owner,
				Describe: fmt.Sprintf("copy %s to %s (%04o%s)",
					placement.CopyFrom, placement.Path, execMode.Perm(), ownerSuffix(owner, "")),
			})
	}

	actions = append(actions, mkdirAction(filepath.Dir(unitPath), unitDirMode, "", "", false))

	unitContent := RenderUnit(in, placement.Path)
	unitOwner, unitGroup := "", ""
	if platform == PlatformLaunchd {
		logPath := logPathFor(in)
		// ~/Library/Logs belongs to the user and usually exists already, so its mode
		// is left alone; /var/log/pdmux is ours and the daemon has to write into it.
		actions = append(actions, mkdirAction(filepath.Dir(logPath), logDirMode, owner, "", !in.User))
		unitContent = RenderPlist(in, placement.Path, logPath)
		if !in.User {
			// launchd refuses to load a LaunchDaemon that is not owned by root:wheel.
			unitOwner, unitGroup = "root", "wheel"
		}
	}
	actions = append(actions, InstallAction{
		Kind:     ActionWrite,
		Path:     unitPath,
		Mode:     unitMode,
		Content:  unitContent,
		Owner:    unitOwner,
		Group:    unitGroup,
		Describe: fmt.Sprintf("write %s (%04o%s)", unitPath, unitMode.Perm(), ownerSuffix(unitOwner, unitGroup)),
	})

	// The state directory is created HERE because nobody else can. internal/state
	// treats an existing, writable /var/lib/pdmux as the signal "this is a system
	// unit" — so when the installer skips it (as the TypeScript one did), a system
	// agent silently falls back to $HOME/.local/state of whatever account it runs
	// as, and the commit-detail ledger it keeps there is rebuilt from scratch on
	// every restart. That looks like a cache that never works and nothing says why.
	actions = append(actions, mkdirAction(stateDir, state.DirMode, owner, "", true))

	var notes []string
	if placement.Note != "" {
		notes = append(notes, placement.Note)
	}

	return InstallPlan{
		Platform:   platform,
		Actions:    actions,
		NextSteps:  nextSteps(in, platform, unitPath),
		Notes:      notes,
		ConfigPath: configPath,
		UnitPath:   unitPath,
		ExecPath:   placement.Path,
		StateDir:   stateDir,
	}, nil
}

func mkdirAction(path string, mode fs.FileMode, owner, group string, enforce bool) InstallAction {
	return InstallAction{
		Kind:        ActionMkdir,
		Path:        path,
		Mode:        mode,
		Owner:       owner,
		Group:       group,
		EnforceMode: enforce,
		Describe:    fmt.Sprintf("create %s (%04o%s)", path, mode.Perm(), ownerSuffix(owner, group)),
	}
}

func ownerSuffix(owner, group string) string {
	if owner == "" {
		return ""
	}
	if group == "" {
		return ", owned by " + owner
	}
	return ", owned by " + owner + ":" + group
}

// nextSteps are printed, never executed — see the file header.
func nextSteps(in InstallInput, platform Platform, unitPath string) []string {
	if platform == PlatformLaunchd {
		if in.User {
			return []string{
				fmt.Sprintf("launchctl bootstrap gui/$(id -u) %s", unitPath),
				fmt.Sprintf("launchctl kickstart -k gui/$(id -u)/%s", LaunchdLabelFor(in)),
			}
		}
		return []string{
			fmt.Sprintf("sudo launchctl bootstrap system %s", unitPath),
			fmt.Sprintf("sudo launchctl kickstart -k system/%s", LaunchdLabelFor(in)),
		}
	}
	systemctl := "sudo systemctl"
	if in.User {
		systemctl = "systemctl --user"
	}
	return []string{
		systemctl + " daemon-reload",
		fmt.Sprintf("%s enable --now %s", systemctl, UnitNameFor(in)),
	}
}

// FormatPlan renders the plan for a human. The token appears in no branch of it.
func FormatPlan(plan InstallPlan, dryRun bool) string {
	prefix := ""
	if dryRun {
		prefix = "[dry-run] would "
	}
	lines := make([]string, 0, len(plan.Actions)+len(plan.NextSteps)+len(plan.Notes)+4)
	for _, action := range plan.Actions {
		lines = append(lines, prefix+action.Describe)
	}
	for _, note := range plan.Notes {
		lines = append(lines, "", "Note:", "  "+note)
	}
	lines = append(lines, "", "Next:")
	for _, step := range plan.NextSteps {
		lines = append(lines, "  "+step)
	}
	return strings.Join(lines, "\n")
}

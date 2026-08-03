// `pdmux-agent instances` — what is installed on THIS machine, and what about
// it does not add up.
//
// ⚠ NOTHING ENUMERATED AN INSTALLED AGENT BEFORE THIS. Every path function in
// install.go derives one path from one input and had no inverse, so an agent
// that was installed and then stopped connecting was invisible from both ends:
// the server has no row for a host that never arrived, and on the host there was
// nothing to ask. `doctor` answers "can THIS configuration reach the server",
// which is a different question and only about the one instance it resolves.
//
// THE MISMATCHES ARE THE PRODUCT, not the listing:
//
//   - a config with no unit is an agent somebody started by hand. It works until
//     the machine reboots, and then it is gone with no error anywhere;
//   - a unit with no config is a half-removed install. It restarts forever
//     against a credential that is not there, which is exactly the shape of the
//     refusal loop the breadcrumb was added for;
//   - a state directory whose link.json says "never accepted" is a host somebody
//     enrolled and nobody ever watched;
//   - "last accepted a month ago" is the one that is invisible on a dashboard,
//     because the host quietly stopped being listed.
//
// ⚠ IT NEVER READS A TOKEN. The config file is decoded into a struct with one
// field, so the credential is dropped at the parse boundary rather than carried
// into a report people paste into issues.
package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	agentnet "github.com/podosoft-dev/pdmux/agent/internal/net"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

// staleAfter is when "last accepted" becomes a finding rather than a fact.
//
// A week, because that is longer than any outage somebody is already dealing
// with and shorter than the time it takes to forget a host exists. It is only
// ever a prompt to look — the row still says exactly when it was.
const staleAfter = 7 * 24 * time.Hour

// InstanceRoots are the directories the three sources live in.
//
// ⚠ EVERY ONE IS DERIVED FROM THE FORWARD INSTALL FUNCTIONS rather than
// restated. A scanner holding its own copy of "/etc/systemd/system" does not
// fail when the installer moves — it silently stops finding what the installer
// writes, which reads as "nothing is installed here" and is the worst answer
// this command could give.
type InstanceRoots struct {
	// Config holds `agent.json` and `agent-<name>.json`.
	UserConfig, SystemConfig string
	// Systemd holds `pdmux-agent*.service`, Launchd `dev.pdmux.agent*.plist`.
	UserSystemd, SystemSystemd string
	UserLaunchd, SystemLaunchd string
	// State is the root an instance's state directory hangs off.
	UserState, SystemState string
}

// DefaultInstanceRoots is where an ordinary machine keeps all six.
//
// ⚠ BOTH SERVICE MANAGERS ARE SCANNED WHATEVER THIS BUILD'S GOOS IS. It costs
// one readdir of a directory that does not exist, and it finds the leftovers on
// a machine that changed service managers — which is precisely the half-removed
// install this command exists to surface.
func DefaultInstanceRoots(home string) InstanceRoots {
	user := InstallInput{User: true, Home: home}
	system := InstallInput{}
	withOS := func(in InstallInput, goos string) InstallInput {
		in.GOOS = goos
		return in
	}
	return InstanceRoots{
		UserConfig:    filepath.Dir(ConfigPathFor(user)),
		SystemConfig:  filepath.Dir(ConfigPathFor(system)),
		UserSystemd:   filepath.Dir(UnitPathFor(withOS(user, "linux"))),
		SystemSystemd: filepath.Dir(UnitPathFor(withOS(system, "linux"))),
		UserLaunchd:   filepath.Dir(UnitPathFor(withOS(user, "darwin"))),
		SystemLaunchd: filepath.Dir(UnitPathFor(withOS(system, "darwin"))),
		UserState:     StateDirFor(user),
		SystemState:   StateDirFor(system),
	}
}

// InstancesInput is everything the scan reads.
//
// Every lookup is a seam so a spec can describe a whole machine inside
// t.TempDir(): the system half of an install lives under /etc, /Library and
// /var/lib, and a spec that read those would be asserting things about whichever
// machine happens to run it.
type InstancesInput struct {
	Roots InstanceRoots
	// ReadDir lists the file names in dir. A missing directory is an empty list
	// and not an error — most machines have one of these six.
	ReadDir func(dir string) []string
	// ReadServer reads the server URL out of a config file, and NOTHING else.
	ReadServer func(path string) (string, bool)
	// ReadLink reads an instance's breadcrumb.
	ReadLink func(dir string) (state.Link, bool, error)
	// Now anchors "how long ago"; the zero value is time.Now().
	Now time.Time
}

// Instance is one installed agent, merged from whichever sources knew about it.
type Instance struct {
	// Name is the --instance name; empty is the default install.
	Name string `json:"name"`
	// User is true for a per-user install (config and unit under a home
	// directory), false for a system one. The same NAME can exist as both, and
	// when it does they are two installs, not one.
	User bool `json:"user"`
	// ConfigPath is empty when no config file was found.
	ConfigPath string `json:"configPath,omitempty"`
	Server     string `json:"server,omitempty"`
	// UnitPath is empty when nothing on this machine will start this agent.
	UnitPath string   `json:"unitPath,omitempty"`
	Platform Platform `json:"platform,omitempty"`
	StateDir string   `json:"stateDir,omitempty"`
	// Link is the breadcrumb, nil when this instance never wrote one.
	Link *state.Link `json:"link,omitempty"`
	// OK is "nothing to look at here"; Findings say what there is.
	OK       bool     `json:"ok"`
	Findings []string `json:"findings,omitempty"`
}

// Label names an instance the way an operator would: the default install is
// `default` rather than an empty column, and the scope is part of the identity
// because a user install and a system install of the same name are two agents.
func (i Instance) Label() string {
	name := i.Name
	if name == "" {
		name = "default"
	}
	scope := "system"
	if i.User {
		scope = "user"
	}
	return fmt.Sprintf("%s (%s)", name, scope)
}

// instanceKey is what makes two findings the same install.
type instanceKey struct {
	name string
	user bool
}

func (in InstancesInput) withDefaults() InstancesInput {
	if in.ReadDir == nil {
		in.ReadDir = readDirNames
	}
	if in.ReadServer == nil {
		in.ReadServer = readConfigServer
	}
	if in.ReadLink == nil {
		in.ReadLink = state.ReadLink
	}
	if in.Now.IsZero() {
		in.Now = time.Now()
	}
	return in
}

// ScanInstances merges the three sources and works out what does not add up.
func ScanInstances(in InstancesInput) []Instance {
	in = in.withDefaults()
	found := map[instanceKey]*Instance{}
	touch := func(name string, user bool) *Instance {
		key := instanceKey{name: name, user: user}
		if row, ok := found[key]; ok {
			return row
		}
		row := &Instance{Name: name, User: user}
		found[key] = row
		return row
	}

	for _, source := range []struct {
		dir  string
		user bool
	}{
		{in.Roots.UserConfig, true},
		{in.Roots.SystemConfig, false},
	} {
		for _, name := range in.ReadDir(source.dir) {
			instance, ok := InstanceFromConfigName(name)
			if !ok {
				continue
			}
			row := touch(instance, source.user)
			row.ConfigPath = filepath.Join(source.dir, name)
			row.Server, _ = in.ReadServer(row.ConfigPath)
		}
	}

	for _, source := range []struct {
		dir      string
		user     bool
		platform Platform
	}{
		{in.Roots.UserSystemd, true, PlatformSystemd},
		{in.Roots.SystemSystemd, false, PlatformSystemd},
		{in.Roots.UserLaunchd, true, PlatformLaunchd},
		{in.Roots.SystemLaunchd, false, PlatformLaunchd},
	} {
		for _, name := range in.ReadDir(source.dir) {
			instance, ok := instanceFromUnitFile(source.platform, name)
			if !ok {
				continue
			}
			row := touch(instance, source.user)
			row.UnitPath = filepath.Join(source.dir, name)
			row.Platform = source.platform
		}
	}

	instances := make([]Instance, 0, len(found))
	for _, row := range found {
		attachLink(row, in)
		row.Findings = findingsFor(*row, in.Now)
		row.OK = len(row.Findings) == 0
		instances = append(instances, *row)
	}
	// Deterministic, and in the order somebody reads it: the default install
	// first, then by name, with a user install before the system one of the same
	// name (that is the order they get installed in).
	sort.Slice(instances, func(a, b int) bool {
		if instances[a].Name != instances[b].Name {
			return instances[a].Name < instances[b].Name
		}
		return instances[a].User && !instances[b].User
	})
	return instances
}

// attachLink finds the breadcrumb for one instance.
//
// ⚠ BOTH ROOTS ARE TRIED, and for the default install that is not belt and
// braces. A NAMED instance's unit pins PDMUX_STATE_DIR, so its directory is
// exactly what the installer computed — but a default install carries no such
// variable on purpose, and internal/state decides at RUN TIME by probing whether
// /var/lib/pdmux exists and is writable. So a per-user agent on a machine that
// has one lands in the system directory, and looking only where this scope would
// put it reports "never connected" for an agent that connects every five seconds.
func attachLink(row *Instance, in InstancesInput) {
	roots := []string{in.Roots.SystemState, in.Roots.UserState}
	if row.User {
		roots = []string{in.Roots.UserState, in.Roots.SystemState}
	}
	for index, root := range roots {
		dir := instanceStateUnder(root, row.Name)
		link, ok, err := in.ReadLink(dir)
		if err != nil || !ok {
			if index == 0 {
				// The scope's own directory is what the row reports when nothing is
				// found anywhere: it is where this install WOULD write.
				row.StateDir = dir
			}
			continue
		}
		row.StateDir, row.Link = dir, &link
		return
	}
}

// findingsFor is the whole point of the command: what about this install does
// not add up.
func findingsFor(row Instance, now time.Time) []string {
	var out []string
	if row.UnitPath == "" {
		out = append(out, "no service unit — nothing starts this agent after a reboot")
	}
	if row.ConfigPath == "" {
		out = append(out, "no config file — a unit that starts this has no credential to dial with")
	}
	switch {
	case row.Link == nil || row.Link.LastConnectedAt == 0:
		// Never ACCEPTED, which is not the same as never started: the breadcrumb is
		// written at `welcome`, so a process that dialled and was refused every time
		// lands here — and that is the host this command was written for.
		//
		// ⚠ IT DOES NOT SAY "NEVER ACCEPTED" FLATLY, because an agent installed
		// before this file existed has no breadcrumb either and is perfectly
		// healthy. Measured on the machine this was built on: the running agent —
		// connected, reporting, somebody's live dashboard — was reported as never
		// accepted, because its binary predated the feature. A first run of this
		// command would have opened with a false alarm about the one agent that was
		// fine. The wording names the evidence instead of the conclusion, and it
		// corrects itself the moment that agent reconnects on a build that writes one.
		out = append(out, "no record of being accepted — refused, or an agent older than this command")
	case now.Sub(time.Unix(row.Link.LastConnectedAt, 0)) > staleAfter:
		out = append(out, fmt.Sprintf("last accepted %s ago", humanAge(now.Sub(time.Unix(row.Link.LastConnectedAt, 0)))))
	}
	if row.Link != nil && row.Link.RefusedSinceConnect() {
		// `refused` on its own reads as "refused since: refused". The agent uses
		// that code when a 401 arrived at the upgrade, which genuinely cannot tell
		// unknown from revoked from expired — so the line says what was observed
		// rather than repeating a word that carries no extra fact.
		if row.Link.LastRefusal.Code == string(agentnet.ReasonRefused) {
			out = append(out, "refused by the server since it last connected")
		} else {
			out = append(out, fmt.Sprintf("refused since it last connected: %s", row.Link.LastRefusal.Code))
		}
	}
	return out
}

// FormatInstances renders the table.
//
// It is FormatChecks' shape — a four-character status column, an aligned label,
// then the detail — so that `doctor` and `instances` read the same way to
// somebody scanning two screens of agent output at three in the morning.
func FormatInstances(instances []Instance) string {
	if len(instances) == 0 {
		return "No pdmux agent is installed here.\n\n" +
			"Nothing was found in the config, service or state directories this installer writes."
	}
	width := 4
	labels := make([]string, len(instances))
	for index, row := range instances {
		labels[index] = row.Label()
		if len(labels[index]) > width {
			width = len(labels[index])
		}
	}
	lines := make([]string, 0, len(instances)+2)
	flagged := 0
	for index, row := range instances {
		status := "OK"
		if !row.OK {
			status = "WARN"
			flagged++
		}
		lines = append(lines, fmt.Sprintf("%-4s  %-*s  %s", status, width, labels[index], instanceDetail(row)))
	}
	if flagged == 0 {
		lines = append(lines, "", fmt.Sprintf("%d instance(s), nothing to flag.", len(instances)))
	} else {
		lines = append(lines, "", fmt.Sprintf("%d of %d instance(s) need attention.", flagged, len(instances)))
	}
	return strings.Join(lines, "\n")
}

func instanceDetail(row Instance) string {
	parts := []string{row.Server}
	if row.Server == "" {
		parts[0] = "no server"
	}
	if row.Link != nil && row.Link.LastConnectedAt > 0 {
		parts = append(parts, "accepted "+time.Unix(row.Link.LastConnectedAt, 0).UTC().Format(time.RFC3339))
	}
	if row.Link != nil && row.Link.HostID != "" {
		parts = append(parts, "host "+row.Link.HostID)
	}
	return strings.Join(append(parts, row.Findings...), "; ")
}

// InstancesJSON is the same answer for something that has to branch on it.
func InstancesJSON(instances []Instance) (string, error) {
	if instances == nil {
		// `[]`, not `null`: a consumer that iterates the field must not have to
		// special-case a machine with nothing installed.
		instances = []Instance{}
	}
	document := struct {
		Instances []Instance `json:"instances"`
	}{Instances: instances}
	encoded, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// instanceFromUnitFile maps a service file name back to its instance.
func instanceFromUnitFile(platform Platform, name string) (string, bool) {
	if platform == PlatformLaunchd {
		return InstanceFromPlistName(name)
	}
	return InstanceFromUnitName(name)
}

// readDirNames lists a directory, treating a missing one as empty.
//
// Six directories are scanned and a normal machine has one or two of them, so
// "not there" is the common case rather than a failure worth reporting.
func readDirNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		names = append(names, entry.Name())
	}
	return names
}

// readConfigServer reads the server address out of a config file and nothing
// else.
//
// ⚠ THE ONE-FIELD STRUCT IS THE POINT. The other value in that file is the host
// token, and this command's output is something people paste into an issue —
// decoding into a struct that has nowhere to put it means the credential is
// dropped by the parser rather than by a later remembering not to print it.
func readConfigServer(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	var document struct {
		Server string `json:"server"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return "", false
	}
	return document.Server, document.Server != ""
}

// humanAge is an age at the precision somebody reading a table wants.
func humanAge(age time.Duration) string {
	switch {
	case age >= 48*time.Hour:
		return fmt.Sprintf("%dd", int(age.Hours())/24)
	case age >= 2*time.Hour:
		return fmt.Sprintf("%dh", int(age.Hours()))
	case age >= 2*time.Minute:
		return fmt.Sprintf("%dm", int(age.Minutes()))
	default:
		return fmt.Sprintf("%ds", int(age.Seconds()))
	}
}

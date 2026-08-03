package update

import (
	"os"
	"runtime"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// HostAbility probes THIS host. It is what agent.Options.UpdateAbility is wired
// to, replacing agent.NoUpdateAbility — which answers "no" for every host and is
// the reason the dashboard currently offers the button nowhere.
func HostAbility() protocol.AgentUpdateAbility {
	return Ability(nil, runtime.GOOS, os.Getppid())
}

// The service-manager probe: "would anything start me again after I exit?"
//
// This answers `hello.update`, which is what decides whether the dashboard shows
// an update button at all. Getting it wrong in one direction hides a working
// feature; getting it wrong in the OTHER direction stops a host dead — the agent
// exits after the swap and nothing ever starts it, so the machine leaves the
// fleet until somebody logs in. That asymmetry is why the default is "no" and
// why an explicit marker beats inference.
const (
	// EnvRestart is written into the unit/plist environment BY THE INSTALLER,
	// which is the only party that actually knows: it is the thing that wrote
	// `Restart=always` or `KeepAlive`. Everything else in this file is a guess
	// about our parent, made from inside the child.
	EnvRestart = "PDMUX_RESTART"

	// RestartService says "a supervisor started me", leaving the flavour to the
	// platform. The installer writes this rather than `systemd`/`launchd` so one
	// unit template does not have to know which of the two it became.
	RestartService = "service"
	// RestartNone is how an operator (or a container entrypoint) says "do not
	// offer the button here", overriding any inference.
	RestartNone = "none"
)

// Ability reports what would restart this agent.
//
// EXPLICIT BEATS INFERRED, ALWAYS. The inference below reads environment
// variables systemd happens to set and a parent pid launchd happens to have;
// both are true of things that are not our supervisor. `INVOCATION_ID` is
// inherited by every child of a unit, so an agent started by hand from `systemd-run`,
// from a unit's ExecStartPost, or from a shell inside a service-managed tmux, all
// look supervised — and none of them would be restarted. On darwin, ppid == 1 is
// true of any orphaned process, which is what a background agent becomes as soon
// as the shell that started it exits. Inference is a fallback for hosts installed
// before the marker existed, not the mechanism.
func Ability(env map[string]string, goos string, ppid int) protocol.AgentUpdateAbility {
	if env == nil {
		env = config.OSEnv()
	}
	ability := protocol.NewAgentUpdateAbility()

	switch env[EnvRestart] {
	case RestartNone:
		return ability
	case string(protocol.RestartSystemd):
		return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd}
	case string(protocol.RestartLaunchd):
		return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartLaunchd}
	case RestartService:
		// The installer says a supervisor owns us; the platform says which one.
		if goos == "darwin" {
			return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartLaunchd}
		}
		return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd}
	}

	switch goos {
	case "linux":
		// systemd sets INVOCATION_ID for every unit it starts, and NOTIFY_SOCKET
		// when the unit asked for readiness notification. Either is evidence.
		if env["INVOCATION_ID"] != "" || env["NOTIFY_SOCKET"] != "" {
			return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartSystemd}
		}
	case "darwin":
		// launchd is pid 1 and is the direct parent of what it starts. It is also
		// the adoptive parent of every orphan, hence the caveat above.
		if ppid == 1 {
			return protocol.AgentUpdateAbility{CanRestart: true, RestartMode: protocol.RestartLaunchd}
		}
	}
	return ability
}

package sys

import (
	"os"
	"runtime"
	"strings"
)

// AgentEnv names the variables that configure the agent process itself:
// config.Env*, state.EnvStateDir, update.EnvRestart, git.EnvGitBin and the
// desktop app's embedded-agent flag. They are spelled out because git and
// update sit above this package; a test pins them to those constants.
//
// They are removed from the environment of the programs the agent starts on a
// person's behalf. PDMUX_TOKEN is the host's credential, and a terminal shell,
// a tmux server the agent starts (and with it every later session), or a hook,
// diff driver or ssh that git runs would otherwise read it and the rest of the
// agent's settings as their own.
var AgentEnv = []string{
	"PDMUX_CONFIG",
	"PDMUX_SERVER",
	"PDMUX_TOKEN",
	"PDMUX_HOSTNAME",
	"PDMUX_LOG_LEVEL",
	"PDMUX_STATE_DIR",
	"PDMUX_RESTART",
	"PDMUX_GIT_BIN",
	"PDMUX_DESKTOP_AGENT",
}

// ChildEnv is the agent's environment without AgentEnv.
func ChildEnv() []string { return WithoutAgentEnv(os.Environ()) }

// WithoutAgentEnv returns environ without the AgentEnv entries.
func WithoutAgentEnv(environ []string) []string {
	out := make([]string, 0, len(environ))
	for _, entry := range environ {
		name, _, _ := strings.Cut(entry, "=")
		if !isAgentEnv(name) {
			out = append(out, entry)
		}
	}
	return out
}

func isAgentEnv(name string) bool {
	for _, control := range AgentEnv {
		// Windows names are case-insensitive, and so is the agent's own lookup there.
		if name == control || runtime.GOOS == "windows" && strings.EqualFold(name, control) {
			return true
		}
	}
	return false
}

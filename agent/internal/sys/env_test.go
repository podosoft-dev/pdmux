package sys_test

import (
	"slices"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/git"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
	"github.com/podosoft-dev/pdmux/agent/internal/update"
)

func TestAgentEnv(t *testing.T) {
	t.Run("[TC-PDTERM-152] names every variable that configures the agent", func(t *testing.T) {
		// PDMUX_DESKTOP_AGENT is read by cmd/pdmux-agent, which has no exported name.
		owned := []string{
			config.EnvConfig, config.EnvServer, config.EnvToken, config.EnvHostname, config.EnvLogLevel,
			state.EnvStateDir, update.EnvRestart, git.EnvGitBin, "PDMUX_DESKTOP_AGENT",
		}
		for _, name := range owned {
			if !slices.Contains(sys.AgentEnv, name) {
				t.Errorf("%s is missing from sys.AgentEnv", name)
			}
		}
		if len(sys.AgentEnv) != len(owned) {
			t.Errorf("sys.AgentEnv = %v, want exactly %v", sys.AgentEnv, owned)
		}
	})

	t.Run("[TC-PDTERM-152] drops only those variables", func(t *testing.T) {
		got := sys.WithoutAgentEnv([]string{
			"PATH=/usr/bin",
			"PDMUX_TOKEN=secret",
			"PDMUX_SERVER=https://pdmux.invalid",
			"PDMUX_USER_NOTE=kept",
			"NOTE=PDMUX_TOKEN=value",
			"PDMUX_TOKEN_FILE=/elsewhere",
		})
		want := []string{"PATH=/usr/bin", "PDMUX_USER_NOTE=kept", "NOTE=PDMUX_TOKEN=value", "PDMUX_TOKEN_FILE=/elsewhere"}
		if !slices.Equal(got, want) {
			t.Fatalf("WithoutAgentEnv = %v, want %v", got, want)
		}
	})
}

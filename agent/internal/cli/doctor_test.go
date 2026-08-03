package cli

import (
	"strings"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
)

func healthyDoctor() DoctorInput {
	return DoctorInput{
		Server:     "https://pdmux.example.com",
		Token:      "doctor-token-value",
		ConfigPath: "/etc/pdmux/agent.json",
		Sources:    config.Sources{Server: config.SourceFile, Token: config.SourceFile},
		WSURL:      "wss://pdmux.example.com/agent/ws",
		Which:      func(string) bool { return true },
		Connect: func(string, string) ProbeResult {
			return ProbeResult{OK: true, Detail: "welcomed as host abc"}
		},
	}
}

func TestRunDoctor(t *testing.T) {
	t.Run("[TC-PDAGENT-033] passes every check on a healthy host", func(t *testing.T) {
		checks := RunDoctor(healthyDoctor())
		for _, check := range checks {
			if !check.OK {
				t.Fatalf("check %q failed on a healthy host: %s", check.Name, check.Detail)
			}
		}
		rendered := FormatChecks(checks)
		if !strings.Contains(rendered, "All checks passed.") {
			t.Fatalf("report:\n%s", rendered)
		}
		if !strings.Contains(rendered, "server from file, token from file (file /etc/pdmux/agent.json)") {
			t.Fatalf("the report must say WHERE the values came from:\n%s", rendered)
		}
	})

	t.Run("[TC-PDAGENT-033] never prints the token itself", func(t *testing.T) {
		rendered := FormatChecks(RunDoctor(healthyDoctor()))
		if strings.Contains(rendered, "doctor-token-value") {
			t.Fatalf("report leaked the token:\n%s", rendered)
		}
		// The length is what tells "I pasted the whole key" from "I pasted a line of it".
		if !strings.Contains(rendered, "*** (18 chars)") {
			t.Fatalf("report:\n%s", rendered)
		}
	})

	t.Run("[TC-PDAGENT-033] names what is missing", func(t *testing.T) {
		in := healthyDoctor()
		in.Token = ""
		in.WSURL = ""
		in.Which = func(command string) bool { return command != "tmux" }
		in.Warnings = []string{"/etc/pdmux/agent.json: config file is not valid JSON"}
		rendered := FormatChecks(RunDoctor(in))
		for _, want := range []string{
			"FAIL  tmux",
			"FAIL  server url",
			"not valid JSON",
			"skipped — no server or token",
			"check(s) failed.",
		} {
			if !strings.Contains(rendered, want) {
				t.Fatalf("report is missing %q:\n%s", want, rendered)
			}
		}
	})

	t.Run("[TC-PDAGENT-033] reports where a value came from when there is no file", func(t *testing.T) {
		in := healthyDoctor()
		in.ConfigPath = ""
		in.Sources = config.Sources{Server: config.SourceEnv, Token: config.SourceFlag}
		rendered := FormatChecks(RunDoctor(in))
		if !strings.Contains(rendered, "server from env, token from flag (no config file found)") {
			t.Fatalf("report:\n%s", rendered)
		}
	})

	t.Run("[TC-PDAGENT-033] does not dial when there is nothing to dial with", func(t *testing.T) {
		in := healthyDoctor()
		in.WSURL = ""
		in.Connect = func(string, string) ProbeResult {
			t.Fatal("connectivity must be skipped, not attempted, without a server url")
			return ProbeResult{}
		}
		FormatChecks(RunDoctor(in))
	})
}

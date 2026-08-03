package cli

import (
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	t.Run("[TC-PDAGENT-034] reads a command with its flags in either form", func(t *testing.T) {
		args := Parse([]string{"install", "--server", "https://x", "--token=abc", "--user", "--dry-run"})
		if args.Command != CommandInstall {
			t.Fatalf("command = %q", args.Command)
		}
		if args.Server != "https://x" || args.Token != "abc" {
			t.Fatalf("values = %q / %q", args.Server, args.Token)
		}
		if !args.User || !args.DryRun {
			t.Fatalf("booleans = %v / %v", args.User, args.DryRun)
		}
		if len(args.Unknown) != 0 {
			t.Fatalf("unknown = %v", args.Unknown)
		}
	})

	t.Run("[TC-PDAGENT-034] defaults to help and collects unknown arguments", func(t *testing.T) {
		if Parse(nil).Command != CommandHelp {
			t.Fatal("no arguments must print help rather than start something")
		}
		unknown := Parse([]string{"--nope"}).Unknown
		if len(unknown) != 1 || unknown[0] != "--nope" {
			t.Fatalf("unknown = %v", unknown)
		}
		// A bare word that is not a command is a mistake too — `pdmux-agent runn`
		// must not fall through to the help screen and exit 0.
		if got := Parse([]string{"runn"}).Unknown; len(got) != 1 {
			t.Fatalf("an unrecognised word must be reported, got %v", got)
		}
		if !strings.Contains(HelpText, "pdmux-agent run") {
			t.Fatal("help must document the run command")
		}
	})

	t.Run("[TC-PDAGENT-034] reads every value flag and both switches", func(t *testing.T) {
		args := Parse([]string{
			"doctor",
			"--config=/etc/pdmux/agent.json",
			"--hostname", "box-1",
			"--log-level=debug",
		})
		if args.Command != CommandDoctor {
			t.Fatalf("command = %q", args.Command)
		}
		if args.Config != "/etc/pdmux/agent.json" || args.Hostname != "box-1" || args.LogLevel != "debug" {
			t.Fatalf("flags = %+v", args)
		}
	})

	t.Run("[TC-PDAGENT-034] treats --help and --version as commands wherever they appear", func(t *testing.T) {
		if got := Parse([]string{"run", "--help"}).Command; got != CommandHelp {
			t.Fatalf("--help after a command = %q", got)
		}
		if got := Parse([]string{"-V"}).Command; got != CommandVersion {
			t.Fatalf("-V = %q", got)
		}
	})

	t.Run("[TC-PDAGENT-034] leaves a value flag with nothing after it empty", func(t *testing.T) {
		// The empty value is what makes the command REFUSE ("Refusing to start
		// without a server and token") instead of dialling the empty string.
		if got := Parse([]string{"install", "--server"}).Server; got != "" {
			t.Fatalf("trailing --server = %q, want empty", got)
		}
		// A value flag takes the next argument whatever it looks like, exactly as
		// the TypeScript did: `--token --user` yields the token "--user" rather than
		// a token silently read from somewhere else. The credential is then wrong
		// and the server says so, which is the failure an operator can act on.
		args := Parse([]string{"install", "--token", "--user"})
		if args.Token != "--user" || args.User {
			t.Fatalf("token = %q, user = %v", args.Token, args.User)
		}
	})
}

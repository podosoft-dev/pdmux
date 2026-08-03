// Package cli is the agent's command surface: `run`, `install`, `doctor` and
// `verify`, plus the argument parsing and the exit codes around them.
//
// WHY THE PARSER IS HAND-WRITTEN: four commands and seven flags do not need a
// framework, and a framework is exactly what would start silently accepting
// things this agent should refuse. An unrecognised argument here EXITS 2 with
// the help text — a typo in a systemd unit (`--sever`) must not turn into a
// daemon that dials nothing and reports nothing about why.
//
// Ported from apps/agent/src/cli/args.ts and apps/agent/src/main.ts.
package cli

import "strings"

// Command is what the user asked for.
type Command string

const (
	CommandRun     Command = "run"
	CommandInstall Command = "install"
	CommandDoctor  Command = "doctor"
	// CommandVerify is new in the Go agent. It is the probe `doctor` already ran
	// as one of its checks, promoted to a command because remote update needs to
	// ask a CANDIDATE binary "can you actually reach the server?" before the swap
	// is committed — and a check that only exists inside a seven-line report
	// cannot be scripted.
	CommandVerify Command = "verify"
	// CommandInstances enumerates every agent installed on this machine. It is the
	// inverse of `install`, and it exists because nothing was: an agent that was
	// installed and then stopped connecting could not be found from either end.
	CommandInstances Command = "instances"
	CommandHelp      Command = "help"
	CommandVersion   Command = "version"
)

// Args is one parsed command line.
type Args struct {
	Command Command
	Server  string
	Token   string
	// Code is a short-lived enrollment code `install` trades for a token. It is an
	// ALTERNATIVE to Token, never a supplement — see commandInstall.
	Code     string
	Config   string
	Hostname string
	LogLevel string
	// User selects a per-user service unit instead of a system one.
	User bool
	// Instance names a second agent on this machine, for `install`. Empty is the
	// ordinary install.
	Instance string
	// DryRun prints the install plan and writes nothing.
	DryRun bool
	// JSON asks `instances` for machine-readable output instead of the table.
	JSON bool
	// Unknown collects what we did not recognise — REPORTED, never ignored.
	Unknown []string
}

// Parse reads argv (without the program name).
//
// Both `--flag value` and `--flag=value` are accepted because both forms turn up
// in the wild: shells and humans write the first, unit files and container
// entrypoints tend to carry the second.
func Parse(argv []string) Args {
	parsed := Args{Command: CommandHelp}
	commandSeen := false
	for index := 0; index < len(argv); index++ {
		arg := argv[index]
		switch arg {
		case "--help", "-h":
			parsed.Command = CommandHelp
			commandSeen = true
			continue
		case "--version", "-V":
			parsed.Command = CommandVersion
			commandSeen = true
			continue
		case "--user":
			parsed.User = true
			continue
		case "--dry-run":
			parsed.DryRun = true
			continue
		case "--json":
			parsed.JSON = true
			continue
		}

		flag, inline, hasInline := strings.Cut(arg, "=")
		if target := valueFlag(&parsed, flag); target != nil {
			value := inline
			if !hasInline {
				// A trailing `--server` with nothing after it resolves to the empty
				// string, which every consumer already treats as "not configured" —
				// so it fails with "Refusing to start without a server and token"
				// rather than swallowing the next flag as a URL.
				value = ""
				if index+1 < len(argv) {
					index++
					value = argv[index]
				}
			}
			*target = value
			continue
		}

		if strings.HasPrefix(arg, "-") {
			parsed.Unknown = append(parsed.Unknown, arg)
			continue
		}
		if !commandSeen && isCommand(arg) {
			parsed.Command = Command(arg)
			commandSeen = true
			continue
		}
		parsed.Unknown = append(parsed.Unknown, arg)
	}
	return parsed
}

// valueFlag maps a flag name onto the field it fills, or nil when the name is
// not a value flag. A pointer table beats a switch that repeats the assignment
// five times — and beats the TypeScript's cast, which only existed because a
// typed union member cannot be assigned dynamically there.
func valueFlag(args *Args, flag string) *string {
	switch flag {
	case "--server":
		return &args.Server
	case "--token":
		return &args.Token
	case "--code":
		return &args.Code
	case "--config":
		return &args.Config
	case "--hostname":
		return &args.Hostname
	case "--instance":
		return &args.Instance
	case "--log-level":
		return &args.LogLevel
	default:
		return nil
	}
}

func isCommand(value string) bool {
	switch Command(value) {
	// ⚠ A COMMAND MISSING FROM THIS LIST IS NOT A MISSING FEATURE, IT IS AN EXIT
	// 2. Parse puts an unrecognised bare word in Args.Unknown, and Main refuses
	// the whole invocation with the help text — so a new const above without a
	// branch here produces a command that exists everywhere except at run time.
	case CommandRun, CommandInstall, CommandDoctor, CommandVerify, CommandInstances:
		return true
	default:
		return false
	}
}

// HelpText is printed for `--help`, for no arguments at all, and alongside the
// exit-2 refusal of an unknown one.
const HelpText = `pdmux-agent — outbound host agent for a pdmux dashboard

Usage:
  pdmux-agent run       [--server <url>] [--token <key>] [--config <path>]
  pdmux-agent install    --server <url> (--token <key> | --code <pdmxe_...>)
                        [--user] [--instance <name>] [--dry-run]
  pdmux-agent doctor    [--server <url>] [--token <key>]
  pdmux-agent verify    [--server <url>] [--token <key>] [--config <path>]
  pdmux-agent instances [--json]

Commands:
  run       Connect to the server and keep reporting (foreground; use a service
            manager — see install).
  install   Write the config file (0600) and a service unit (systemd on Linux,
            launchd on macOS), then print the commands that enable it. --user
            installs a per-user unit instead of a system one.
            --code redeems a short-lived enrollment code for the host token
            first, so no long-lived credential is ever typed on a command line.
            A code is single use; --dry-run leaves it unredeemed.
            --instance installs a SECOND agent beside the machine's existing one,
            with its own config, state, service and binary — so a spare agent can
            point at a development server without disconnecting the one already
            serving somebody's dashboard.
  doctor    Check configuration, tooling, PTY and server connectivity.
  verify    Dial the server and exit 0 only if it answered with a welcome frame.
  instances List every agent installed on this machine — its config, its service
            unit and whether a server has ever accepted it — and flag what does
            not add up (a config with no unit, a unit with no config, an agent
            that has never connected or has not been accepted in a week). It
            enumerates rather than checks, so it exits 0 whenever the scan ran;
            --json carries the per-instance verdict for a script that branches.

Exit codes:
  0  done          2  refused (bad arguments)    4  host is disabled
  1  failed        3  enrollment code rejected   5  rate limited, try later

Configuration precedence: CLI flags > environment > config file.
  PDMUX_SERVER, PDMUX_TOKEN, PDMUX_HOSTNAME, PDMUX_LOG_LEVEL, PDMUX_CONFIG
  ~/.config/pdmux/agent.json, then /etc/pdmux/agent.json
`

package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"strings"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

// Exit codes are a contract — install scripts and the remote-update flow branch
// on them, so they are named here rather than typed as literals at each return.
const (
	exitOK = 0
	// exitFailed is "I ran and the answer is no": a check failed, a write failed,
	// the server did not welcome us.
	exitFailed = 1
	// exitRefused is "I did not run": bad arguments, or a configuration too
	// incomplete to act on. It must stay distinguishable from exitFailed, because
	// an installer retrying a 1 makes sense and retrying a 2 never does.
	exitRefused = 2

	// The three below are `install --code` refusals the SERVER decided, split out
	// so install.sh can say something useful without parsing our stderr. Each one
	// has a different human next step, which is the whole reason they are not one
	// code: 3 means fetch a fresh code from the dashboard, 4 means enable the host
	// and reuse the same code, 5 means wait.

	// exitEnrollRejected is 401 ENROLL_CODE_INVALID — malformed, unknown, expired,
	// already redeemed or revoked, deliberately indistinguishable from each other.
	exitEnrollRejected = 3
	// exitEnrollHostDisabled is 409 HOST_DISABLED. The code was NOT consumed.
	exitEnrollHostDisabled = 4
	// exitEnrollThrottled is 429. Retrying only extends the block.
	exitEnrollThrottled = 5
)

// DaemonConfig is what `run` hands the agent runtime.
type DaemonConfig struct {
	// URL is the normalised wss:// endpoint.
	URL      string
	Token    string
	Hostname string
	Version  string
	Logger   *log.Logger
	// ConfigPath is the file that supplied the file layer of this run's
	// configuration, empty when none did.
	//
	// It is carried for remote update: before a downloaded binary is committed,
	// the running agent execs it as `<candidate> verify --config <this path>`, so
	// Gate 1 exercises THIS HOST'S REAL CONFIGURATION. A new build that regressed
	// its config parser is otherwise indistinguishable from a healthy one until it
	// is the installed binary and cannot start — which is the failure the whole
	// update path is ordered around.
	ConfigPath string
}

// DaemonFunc is the runtime `run` starts. It returns when ctx is cancelled.
//
// WHY THIS IS A SEAM: internal/agent owns the loop; this package owns the command
// surface. Keeping them apart means the CLI's specs never start a daemon, and the
// daemon never has an opinion about argv.
type DaemonFunc func(ctx context.Context, cfg DaemonConfig) error

// Deps are the process-level facts and side effects the commands need. Every one
// is injectable, so the specs run a whole command against a temp directory.
type Deps struct {
	Stdout io.Writer
	Stderr io.Writer
	// Env is the process environment; nil reads the real one.
	Env map[string]string
	// ReadConfigFile reads config candidates; nil reads the real filesystem.
	ReadConfigFile config.ReadFileFunc
	// Home is the home directory used for config candidates and --user paths.
	Home string
	// Username is the account running this process.
	Username string
	// Executable is the path of the running binary — what a unit will start.
	Executable string
	// GOOS overrides the target platform for `install`; empty means this build's.
	GOOS string
	// ExecDirWritable, Which and Probe are the host lookups; nil uses the real one.
	ExecDirWritable func(dir, serviceUser string) bool
	Which           func(command string) bool
	Probe           func(ctx context.Context, url, token string) ProbeResult
	// InstallIO applies an install plan; nil writes to the real filesystem.
	InstallIO *InstallIO
	// Daemon runs the agent for `run`.
	Daemon DaemonFunc
}

func (d Deps) withDefaults() Deps {
	if d.Stdout == nil {
		d.Stdout = os.Stdout
	}
	if d.Stderr == nil {
		d.Stderr = os.Stderr
	}
	if d.Env == nil {
		d.Env = config.OSEnv()
	}
	if d.Home == "" {
		d.Home, _ = os.UserHomeDir()
	}
	if d.Username == "" {
		if account, err := user.Current(); err == nil {
			d.Username = account.Username
		}
	}
	if d.Executable == "" {
		d.Executable, _ = ExecutablePath()
	}
	if d.Which == nil {
		d.Which = whichOnPath
	}
	if d.Probe == nil {
		d.Probe = func(ctx context.Context, url, token string) ProbeResult {
			return Probe(ctx, url, token, DefaultProbeTimeout)
		}
	}
	return d
}

// Main runs one command and returns the process exit code.
func Main(ctx context.Context, argv []string, deps Deps) int {
	deps = deps.withDefaults()
	args := Parse(argv)
	if len(args.Unknown) > 0 {
		// Refused, not ignored: a mistyped flag in a unit file (`--sever`) would
		// otherwise start a daemon that dials nothing and never says why.
		fmt.Fprintf(deps.Stderr, "Unknown argument(s): %s\n\n%s", strings.Join(args.Unknown, " "), HelpText)
		return exitRefused
	}
	switch args.Command {
	case CommandRun:
		return commandRun(ctx, args, deps)
	case CommandInstall:
		return commandInstall(ctx, args, deps)
	case CommandDoctor:
		return commandDoctor(ctx, args, deps)
	case CommandVerify:
		return commandVerify(ctx, args, deps)
	case CommandInstances:
		return commandInstances(args, deps)
	case CommandVersion:
		fmt.Fprintln(deps.Stdout, AgentVersion)
		return exitOK
	default:
		fmt.Fprint(deps.Stdout, HelpText)
		return exitOK
	}
}

func resolve(args Args, deps Deps) config.Resolved {
	return config.Resolve(config.Input{
		Flags: config.Flags{
			Server:   args.Server,
			Token:    args.Token,
			Config:   args.Config,
			Hostname: args.Hostname,
			LogLevel: args.LogLevel,
		},
		Env:      deps.Env,
		HomeDir:  deps.Home,
		ReadFile: deps.ReadConfigFile,
	})
}

// newLogger builds the logger for a command, with the token registered BEFORE
// anything can log — including the connect line, which carries the URL.
func newLogger(resolved config.Resolved, deps Deps) *log.Logger {
	level, ok := log.ParseLevel(resolved.LogLevel)
	logger := log.New(log.Options{
		Level:   level,
		Secrets: []string{resolved.Token},
		Sink:    func(line string) { fmt.Fprintln(deps.Stderr, line) },
	})
	if !ok && resolved.LogLevel != "" {
		// Silently defaulting would hide a typo in a unit file that the operator
		// set precisely because they were trying to see more.
		logger.Warn("Ignoring unknown log level", log.F("value", resolved.LogLevel), log.F("using", level.String()))
	}
	return logger
}

func commandRun(ctx context.Context, args Args, deps Deps) int {
	resolved := resolve(args, deps)
	logger := newLogger(resolved, deps)
	for _, warning := range resolved.Warnings {
		logger.Warn("Ignoring unusable config file", log.F("warning", warning))
	}
	if resolved.Server == "" || resolved.Token == "" {
		logger.Error("Refusing to start without a server and token",
			log.F("hint", "pdmux-agent install --server <url> --token <key>"))
		return exitRefused
	}
	url, err := config.ToWebSocketURL(resolved.Server)
	if err != nil {
		logger.Error("Refusing to start with an unusable server address", log.F("error", err))
		return exitRefused
	}
	if deps.Daemon == nil {
		logger.Error("This build has no agent runtime wired in")
		return exitFailed
	}

	logger.Info("Starting agent", log.F("version", AgentVersion), log.F("host", hostnameFor(resolved)))
	err = deps.Daemon(ctx, DaemonConfig{
		URL:      url,
		Token:    resolved.Token,
		Hostname: resolved.Hostname,
		Version:  AgentVersion,
		Logger:   logger,
		// The RESOLVED path, not the flag: a host configured entirely by
		// /etc/pdmux/agent.json passes no --config, and that file is exactly the one
		// a candidate binary has to prove it can still read.
		ConfigPath: resolved.ConfigPath,
	})
	if err != nil && ctx.Err() == nil {
		logger.Error("Agent stopped", log.F("error", err))
		return exitFailed
	}
	// A cancelled context is how the daemon is asked to stop, so the error it
	// returns on the way out is the request, not a failure.
	logger.Info("Stopped agent")
	return exitOK
}

func commandInstall(ctx context.Context, args Args, deps Deps) int {
	resolved := resolve(args, deps)
	logger := newLogger(resolved, deps)
	// The code is a credential too, and the only one that can be on this command
	// line. Registered before anything runs, so no log line can carry it.
	logger.AddSecret(args.Code)

	if args.Code != "" && args.Token != "" {
		// Refused rather than resolved by a precedence rule. Whichever one silently
		// lost, the operator believes they installed with the other — and if the
		// code lost, they are left holding a live code they think was spent.
		logger.Error("Refusing to install with both --code and --token",
			log.F("hint", "--code redeems an enrollment code for a token; pass one or the other"))
		return exitRefused
	}
	if resolved.Server == "" || (args.Code == "" && resolved.Token == "") {
		logger.Error("Refusing to install without --server and --token",
			log.F("hint", "or enrol this host with --server <url> --code <pdmxe_...>"))
		return exitRefused
	}
	// ⚠ CHECKED BEFORE THE CODE IS REDEEMED. An enrollment code is single-use, so
	// refusing a bad instance name afterwards would spend it and leave the operator
	// with nothing to retry with.
	if err := ValidateInstance(args.Instance); err != nil {
		logger.Error("Refusing to install", log.F("error", err))
		return exitRefused
	}

	token := resolved.Token
	if args.Code != "" {
		enrolled, code := redeemForInstall(ctx, args, resolved, deps, logger)
		if code != exitOK {
			return code
		}
		token = enrolled
	}

	plan, err := PlanInstall(InstallInput{
		Server:          resolved.Server,
		Token:           token,
		User:            args.User,
		Instance:        args.Instance,
		Home:            deps.Home,
		BinaryPath:      deps.Executable,
		RunAs:           ServiceUser(deps.Env, deps.Username),
		Hostname:        resolved.Hostname,
		GOOS:            deps.GOOS,
		ExecDirWritable: deps.ExecDirWritable,
	})
	if err != nil {
		logger.Error("Refusing to install", log.F("error", err))
		return exitRefused
	}
	// The plan is printed BEFORE it is applied, so a failure halfway through is
	// read against the list of what was supposed to happen.
	fmt.Fprintln(deps.Stdout, FormatPlan(plan, args.DryRun))
	if args.DryRun {
		return exitOK
	}
	applier := DefaultInstallIO()
	if deps.InstallIO != nil {
		applier = *deps.InstallIO
	}
	if err := ApplyPlan(plan, applier); err != nil {
		logger.Error("Failed to write installation files", log.F("error", err))
		return exitFailed
	}
	return exitOK
}

// redeemForInstall trades --code for the token the plan will write.
//
// The int is an exit code: exitOK means "carry on with this token", anything else
// is what the process must return. A refusal here ends the install BEFORE any file
// is written — a config with no token in it is worse than no config at all,
// because the unit it accompanies would start, fail to authenticate and restart
// forever.
func redeemForInstall(
	ctx context.Context,
	args Args,
	resolved config.Resolved,
	deps Deps,
	logger *log.Logger,
) (string, int) {
	endpoint, err := EnrollURL(resolved.Server)
	if err != nil {
		logger.Error("Refusing to enrol with an unusable server address", log.F("error", err))
		return "", exitRefused
	}

	if args.DryRun {
		// ⚠ THE POINT OF THIS BRANCH. A code is single use, so a dry run that
		// redeemed it would leave the real run to fail with "code is not valid" —
		// the rehearsal breaking the performance. Nothing is sent from here.
		//
		// The code is printed as *** for the same reason the token is: --dry-run
		// output is what people paste into an issue when the install misbehaves.
		fmt.Fprintf(deps.Stdout,
			"[dry-run] would exchange enrollment code %s at %s for a host token\n"+
				"[dry-run] the code was NOT redeemed and is still usable\n\n",
			log.Redacted, endpoint)
		// An empty token: the plan is printed, never applied, and FormatPlan renders
		// only the Describe lines, which name the token without carrying it.
		return "", exitOK
	}

	result, err := Enroll(ctx, EnrollInput{
		Server:   resolved.Server,
		Code:     args.Code,
		Hostname: hostnameFor(resolved),
		Logger:   logger,
	})
	if err != nil {
		var refusal *EnrollError
		if errors.As(err, &refusal) {
			// The server's own message, because it knows which of the five reasons a
			// code can be invalid actually applied — and the exit code it chose, so
			// install.sh can say the same thing without parsing this line.
			logger.Error("Enrollment failed", log.F("error", refusal.Message))
			return "", refusal.ExitCode
		}
		logger.Error("Enrollment failed", log.F("error", err))
		return "", exitFailed
	}
	// Names the host row that was claimed so an operator can tell immediately that
	// they installed onto the machine they meant. No credential in either field.
	fmt.Fprintf(deps.Stdout, "Enrolled as host %s (%s)\n\n", result.HostLabel, result.HostID)
	return result.Token, exitOK
}

func commandDoctor(ctx context.Context, args Args, deps Deps) int {
	resolved := resolve(args, deps)
	warnings := resolved.Warnings
	wsURL := ""
	if resolved.Server != "" {
		url, err := config.ToWebSocketURL(resolved.Server)
		if err != nil {
			// Reported as a config-file warning line rather than thrown away: "the
			// server url check failed" without saying what was wrong with the value
			// is the report answering its own question with a shrug.
			warnings = append(warnings, err.Error())
		} else {
			wsURL = url
		}
	}
	checks := RunDoctor(DoctorInput{
		Server:     resolved.Server,
		Token:      resolved.Token,
		ConfigPath: resolved.ConfigPath,
		Sources:    resolved.Sources,
		Warnings:   warnings,
		WSURL:      wsURL,
		Which:      deps.Which,
		Connect: func(url, token string) ProbeResult {
			return deps.Probe(ctx, url, token)
		},
	})
	fmt.Fprintln(deps.Stdout, FormatChecks(checks))
	for _, check := range checks {
		if !check.OK {
			return exitFailed
		}
	}
	return exitOK
}

// commandVerify is `doctor`'s connectivity check on its own, with an exit code.
//
// It exists for remote update: before a downloaded binary is committed as the one
// the unit starts, something has to prove that THAT BUILD can complete a real
// handshake with THIS server. A TCP connect proves nothing (a proxy answers it),
// and `doctor` cannot be used because its exit code also covers tmux and git.
func commandVerify(ctx context.Context, args Args, deps Deps) int {
	resolved := resolve(args, deps)
	if resolved.Server == "" || resolved.Token == "" {
		fmt.Fprintln(deps.Stderr, "Refusing to verify without a server and token")
		return exitRefused
	}
	url, err := config.ToWebSocketURL(resolved.Server)
	if err != nil {
		fmt.Fprintf(deps.Stderr, "Refusing to verify an unusable server address: %v\n", err)
		return exitRefused
	}
	result := deps.Probe(ctx, url, resolved.Token)
	if !result.OK {
		fmt.Fprintf(deps.Stderr, "verify failed: %s (%s)\n", result.Detail, url)
		return exitFailed
	}
	fmt.Fprintf(deps.Stdout, "verified: %s (%s)\n", result.Detail, url)
	return exitOK
}

// commandInstances lists what is installed here.
//
// ⚠ IT EXITS 0 EVEN WHEN IT FLAGS SOMETHING, and that is a deliberate difference
// from `doctor`. This is an enumeration, not a check: a freshly installed agent
// that has not been started yet legitimately has no breadcrumb, and an exit code
// that called that a failure would make the command useless inside the install
// script that just wrote the files. The per-instance verdict is in --json, which
// is what a script that wants to branch should read.
//
// It resolves nothing from the environment on purpose: `instances` answers what
// is on the MACHINE, not what this invocation's flags and PDMUX_* would resolve
// to — those describe one agent, and this command exists because the machine can
// hold several.
func commandInstances(args Args, deps Deps) int {
	instances := ScanInstances(InstancesInput{Roots: DefaultInstanceRoots(deps.Home)})
	if args.JSON {
		encoded, err := InstancesJSON(instances)
		if err != nil {
			fmt.Fprintf(deps.Stderr, "Cannot render the instance list: %v\n", err)
			return exitFailed
		}
		fmt.Fprintln(deps.Stdout, encoded)
		return exitOK
	}
	fmt.Fprintln(deps.Stdout, FormatInstances(instances))
	return exitOK
}

// ServiceUser is the account a SYSTEM unit should run as.
//
// A system install is run with sudo, so the current user is root — and the
// TypeScript installer wrote `User=root` into the unit without ever saying so.
// This daemon reads someone's checkouts, opens PTYs into their tmux sessions and
// (soon) replaces its own binary; none of that wants uid 0. SUDO_USER is the
// human who asked for the install, their home is where those checkouts and
// sessions live, and the choice is printed in the plan as `User=<name>` rather
// than being made silently.
func ServiceUser(env map[string]string, current string) string {
	if invoker := env["SUDO_USER"]; invoker != "" && invoker != "root" {
		return invoker
	}
	return current
}

func hostnameFor(resolved config.Resolved) string {
	if resolved.Hostname != "" {
		return resolved.Hostname
	}
	if name, err := os.Hostname(); err == nil {
		return name
	}
	return "unknown"
}

// whichOnPath is the default for Deps.Which: a PATH lookup rather than the
// TypeScript's `which` child process, which answered the same question by
// spawning something.
func whichOnPath(command string) bool {
	_, found := sys.Which(command)
	return found
}

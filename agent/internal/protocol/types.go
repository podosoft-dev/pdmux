// Package protocol is the Go side of the agent <-> server contract.
//
// THE SOURCE OF TRUTH IS TYPESCRIPT: packages/protocol/src/index.ts. Three
// programs have to agree on these shapes (the NestJS API, the SvelteKit web app
// and this agent), so the shapes are declared once, in zod, and this package is
// a port — not a second opinion. Where the two could disagree, the disagreement
// is caught by data rather than by review:
//
//   - the JSON Schema generated from zod is embedded here and validates every
//     frame at runtime (validate.go),
//   - every schema default is transcribed by a generator, never by hand
//     (gen/main.go -> defaults_gen.go),
//   - a shared conformance corpus proves both languages normalise the same
//     frames to the same values (conformance_test.go).
//
// WHY THAT MACHINERY IS WORTH IT: a mismatch here throws nothing. A field comes
// out 0 instead of null and a host that failed to measure its CPU reads as
// "healthy but idle" on the dashboard (pdmux-work/docs/CONTRACTS.md C3). Silence is the
// failure mode, so the checks have to be mechanical.
//
// TWO RULES DECIDE MOST OF THIS FILE:
//
//  1. NO `omitempty`, with exactly two exceptions. zod fills defaults for keys
//     that are *undefined*, so a key the agent omits is a key the server
//     substitutes — and the two sides only agree if Go sends what zod would
//     have produced. The exceptions are the two genuine optionals
//     (usageWindow.label, terminalTarget.session): they have no default at all,
//     so zod leaves the key ABSENT and Go must too. They are pointers for that
//     reason, not because they are nullable.
//
//  2. EVERY NULLABLE SITE IS A POINTER. `null` means "this measurement failed"
//     and is load-bearing; a zero value would claim the opposite. There are 32
//     of them and none may be a plain int/string/float.
//
// A third rule has no syntax to enforce it: SLICES MUST MARSHAL AS `[]`, NEVER
// `null`. A nil Go slice marshals to `null`, and zod's `.default([])` only fills
// `undefined` — so `capabilities: null` fails the element, fails the array,
// fails the whole `hello`, and the host never registers. Use the generated
// NewXxx constructors (defaults_gen.go), which seed every slice.
package protocol

// ---------------------------------------------------------------------------
// Enumerations
//
// Fixed string sets get a named Go type so a typo is a compile error rather
// than a frame the server drops. The wire values are the zod enum members.
// ---------------------------------------------------------------------------

// AgentCapability is what this build can do, so the server does not offer a
// feature the host cannot serve.
//
// ⚠ An unknown MEMBER is fatal where an unknown FIELD is merely stripped: a
// newer agent inventing a capability an older server does not know fails the
// element, the array, and the whole `hello` — that host silently vanishes from
// the dashboard. Anything that might need to grow independently belongs in its
// own object (see AgentUpdateAbility), not in this enum.
type AgentCapability string

const (
	CapabilityMetrics  AgentCapability = "metrics"
	CapabilitySessions AgentCapability = "sessions"
	CapabilityTerminal AgentCapability = "terminal"
	CapabilityGit      AgentCapability = "git"
	CapabilityUsage    AgentCapability = "usage"
	CapabilityServices AgentCapability = "services"
	// CapabilityExec reports that this agent understands the exec frame. An agent
	// built before it simply omits the value, and the server reads that rather than
	// assuming — an old agent would ignore the frame silently and the caller would
	// wait for an answer that is never coming.
	CapabilityExec AgentCapability = "exec"
	// CapabilityFiles reports that this agent can list a directory and read a file
	// under its user's home. Read the way `exec` is read: an older agent ignores
	// the frame, so the screen has to know not to offer the explorer rather than
	// leave somebody waiting on an answer that is not coming.
	//
	// ⚠ IT ALSO MEANS THE HOME EXISTS. It is announced only when `$HOME` resolved
	// to a real directory — a service account with no home has nothing to browse,
	// and that is a fact about the host rather than an error to report.
	CapabilityFiles AgentCapability = "files"
)

// RestartMode names what would start the agent again after it replaces its own
// binary and exits. With no service manager, exiting is a hole it never climbs
// out of — so the server must know not to offer the update button.
type RestartMode string

const (
	RestartSystemd RestartMode = "systemd"
	RestartLaunchd RestartMode = "launchd"
	RestartNone    RestartMode = "none"
)

// DiagnosticLevel grades something the agent cannot fix by itself.
type DiagnosticLevel string

const (
	DiagnosticInfo  DiagnosticLevel = "info"
	DiagnosticWarn  DiagnosticLevel = "warn"
	DiagnosticError DiagnosticLevel = "error"
)

// ProbeStatus is the outcome of probing one registered service port.
type ProbeStatus string

const (
	ProbeUp      ProbeStatus = "up"
	ProbeDown    ProbeStatus = "down"
	ProbeUnknown ProbeStatus = "unknown"
)

// ProbeKind is how the server wants a service port probed.
type ProbeKind string

const (
	ProbeTCP  ProbeKind = "tcp"
	ProbeHTTP ProbeKind = "http"
	ProbeNone ProbeKind = "none"
)

// GitRefKind separates the three namespaces a ref can live in.
type GitRefKind string

const (
	GitRefLocal  GitRefKind = "local"
	GitRefRemote GitRefKind = "remote"
	GitRefTag    GitRefKind = "tag"
)

// DiffStatus is git's own letter for what happened to a file.
type DiffStatus string

const (
	DiffAdded    DiffStatus = "A"
	DiffModified DiffStatus = "M"
	DiffDeleted  DiffStatus = "D"
	DiffRenamed  DiffStatus = "R"
)

// UpdatePhase is both progress and outcome of a remote update.
//
// WHO SENDS WHICH: `done` comes from the NEW binary once it has completed its
// own handshake, `rolledBack` from the OLD one after it restored itself. Every
// outcome is reported by an agent that is connected, so the server never has to
// infer failure from silence — the reading that turns a slow host into a false
// alarm.
type UpdatePhase string

const (
	PhaseAccepted    UpdatePhase = "accepted"
	PhaseDownloading UpdatePhase = "downloading"
	PhaseVerifying   UpdatePhase = "verifying"
	PhaseSwapping    UpdatePhase = "swapping"
	PhaseRestarting  UpdatePhase = "restarting"
	PhaseDone        UpdatePhase = "done"
	PhaseFailed      UpdatePhase = "failed"
	PhaseRolledBack  UpdatePhase = "rolledBack"
)

// TerminalKind is what a terminal attaches to.
type TerminalKind string

const (
	// TerminalSession attaches to (or creates) a named multiplexer session —
	// it survives a dropped connection, which is why it is the default.
	TerminalSession TerminalKind = "session"
	// TerminalShell is a bare login shell; it dies with the connection (the UI warns).
	TerminalShell TerminalKind = "shell"
)

// CollectWhat asks for one immediate pass, so "refresh" does not wait out the
// configured interval.
type CollectWhat string

const (
	CollectHeartbeat CollectWhat = "heartbeat"
	CollectRepos     CollectWhat = "repos"
	// CollectRemote leaves the machine, which is why it is never on the agent's own
	// timer: it only ever arrives because somebody pressed a button.
	CollectRemote CollectWhat = "remote"
)

// ---------------------------------------------------------------------------
// Primitives and host state
// ---------------------------------------------------------------------------

// MuxSession is a terminal multiplexer session on the host (tmux today; the
// shape is generic on purpose — `attached` and `windows` are what a target
// picker needs to show).
type MuxSession struct {
	Name     string `json:"name"`
	Attached int    `json:"attached"`
	Windows  int    `json:"windows"`
}

// UsageWindow is one usage window reported by a coding agent (e.g. a session
// window and a weekly window).
//
// BOTH POLARITIES TRAVEL: providers disagree — one reports what is left, the
// other what is spent — and a card should always draw "remaining". Keeping both
// means a tooltip can show the number the provider's own UI shows.
type UsageWindow struct {
	// Key is a stable key chosen by the provider adapter, e.g. `session`, `weekly`.
	Key string `json:"key"`
	// Label is a fallback for a UI with no translation for Key. One of the two
	// fields in the whole protocol with no default: when it is absent zod leaves
	// the KEY ABSENT, so Go must omit it too rather than send "".
	Label        *string `json:"label,omitempty"`
	UsedPct      *int    `json:"usedPct"`
	RemainingPct *int    `json:"remainingPct"`
	// ResetsAt is when this window resets. A window whose reset already passed is dropped.
	ResetsAt *int64 `json:"resetsAt"`
}

// AgentUsage is one provider's token budget as last measured on this host.
type AgentUsage struct {
	// Provider is a provider id, e.g. the CLI's binary name. The core stays provider-neutral.
	Provider string `json:"provider"`
	// Processes is the live process count for that provider (exact name match, not a cmdline grep).
	Processes int `json:"processes"`
	// Ts is when the numbers were taken — a stale snapshot is dimmed, not hidden.
	Ts      *int64        `json:"ts"`
	Windows []UsageWindow `json:"windows"`
}

// ServiceProbe is the result of probing one registered service port on the host.
type ServiceProbe struct {
	// ID is the server-assigned service id, echoed back so the UI can join without guessing.
	ID        string      `json:"id"`
	Status    ProbeStatus `json:"status"`
	LatencyMs *int        `json:"latencyMs"`
}

// Listener is a TCP port the host is currently listening on — discovered, not
// registered.
//
// ⚠ NO PID FIELD, DELIBERATELY. A pid cannot be read off a screen usefully and
// shipping the host's process table to a remote dashboard discloses more than
// this product needs to. The process NAME is what a person reads the row by.
type Listener struct {
	Port int `json:"port"`
	// Process is the executable name, not a command line — an argv can carry a token.
	Process string `json:"process"`
	// LoopbackOnly means nothing off the host reaches it today. A service bound
	// to 127.0.0.1 is often unauthenticated for exactly that reason.
	LoopbackOnly bool `json:"loopbackOnly"`
}

// Resource is resource usage. Absolute bytes travel WITH the percentages: a
// tooltip wants "12Gi/30Gi" and a percentage alone cannot produce it.
//
// Every field is a pointer because every one of them can fail to be measured,
// and `null` is the only honest way to say so. The byte and load fields are
// `number` (not `int`) in the contract, hence float64.
//
// ⚠ THE SWAP FIELDS HAVE A THIRD STATE THE OTHERS DO NOT. A host with swap
// turned off measures perfectly — total 0, used 0 — so its byte fields are set
// and only the percentage is a judgement call. See collect.SwapReading for which
// way that call goes and why.
type Resource struct {
	CPUPct         *int     `json:"cpuPct"`
	MemPct         *int     `json:"memPct"`
	DiskPct        *int     `json:"diskPct"`
	MemUsedBytes   *float64 `json:"memUsedBytes"`
	MemTotalBytes  *float64 `json:"memTotalBytes"`
	DiskUsedBytes  *float64 `json:"diskUsedBytes"`
	DiskTotalBytes *float64 `json:"diskTotalBytes"`
	SwapPct        *int     `json:"swapPct"`
	SwapUsedBytes  *float64 `json:"swapUsedBytes"`
	SwapTotalBytes *float64 `json:"swapTotalBytes"`
	Load1          *float64 `json:"load1"`
	UptimeSec      *int64   `json:"uptimeSec"`
}

// AgentDiagnostic is something the agent cannot fix by itself and the operator
// should see: git is missing, the state directory is unwritable, the PTY fell
// back to a limited mode. Without this it only shows up in `doctor` output on
// the host — which nobody runs until they already suspect a problem.
type AgentDiagnostic struct {
	Level DiagnosticLevel `json:"level"`
	// Code is a stable code so a UI can translate it; Message is the fallback.
	Code string `json:"code"`
	// Message is rendered in a browser: never put a token, a path outside the
	// server-given config, or a hostname nobody asked for in here.
	Message string `json:"message"`
}

// Heartbeat is what a host looks like right now.
type Heartbeat struct {
	Ts       int64          `json:"ts"`
	Resource Resource       `json:"resource"`
	Sessions []MuxSession   `json:"sessions"`
	Usage    []AgentUsage   `json:"usage"`
	Services []ServiceProbe `json:"services"`
	// Listeners are ports discovered listening on the host.
	//
	// ⚠ A POINTER SO THAT "DID NOT LOOK" AND "FOUND NONE" STAY DIFFERENT ON THE
	// WIRE. nil omits the key, which is what an agent too old to know about this
	// field produces; a pointer to an empty slice still marshals as `[]`, which is
	// this agent saying it looked and found nothing. Collapsing the two made the
	// dashboard tell a host's owner "nothing is listening" about a host nobody had
	// asked. Always set it — even to an empty slice.
	//
	// ⚠ THE CONTRACT'S CAP IS A REJECTION, NOT A TRUNCATION — too many entries
	// fails the whole heartbeat and takes the resource bars and sessions with
	// it. Truncate before sending; see collect.MaxListeners.
	Listeners *[]Listener `json:"listeners,omitempty"`
	// Diagnostics are degraded capabilities on the host — surfaced on the card, not just in logs.
	Diagnostics []AgentDiagnostic `json:"diagnostics"`
}

// ---------------------------------------------------------------------------
// Git — read-only snapshots
// ---------------------------------------------------------------------------

// GitRef is one branch, remote-tracking branch or tag.
type GitRef struct {
	Name     string     `json:"name"`
	Kind     GitRefKind `json:"kind"`
	Sha      string     `json:"sha"`
	Upstream *string    `json:"upstream"`
	Ahead    *int       `json:"ahead"`
	Behind   *int       `json:"behind"`
	// Gone marks an upstream branch that no longer exists on the remote — a
	// branch you can only push anew.
	Gone bool `json:"gone"`
}

// GitCommit is a row in the graph — and nothing more. The message body, the file
// list and the patch are fetched when a commit is clicked: they were 58% of the
// feed when they travelled with the list, and none of it is rendered before that
// click.
type GitCommit struct {
	Sha     string   `json:"sha"`
	Parents []string `json:"parents"`
	Refs    []string `json:"refs"`
	Author  string   `json:"author"`
	Date    *int64   `json:"date"`
	Subject string   `json:"subject"`
}

// GitStatusFile is one entry of `git status --porcelain=v2`.
type GitStatusFile struct {
	Path string `json:"path"`
	// X and Y are porcelain v2 index/worktree letters; `?` for untracked.
	//
	// ⚠ They default to a SPACE, not to "". The contract only caps the length,
	// so Go's zero string is ACCEPTED and stored as an empty letter — no error
	// anywhere. Build these through NewGitStatusFile, never as a bare literal.
	X string `json:"x"`
	Y string `json:"y"`
}

// GitUncommitted summarises work in the tree that is not committed yet.
type GitUncommitted struct {
	Staged    int             `json:"staged"`
	Unstaged  int             `json:"unstaged"`
	Untracked int             `json:"untracked"`
	Conflicts int             `json:"conflicts"`
	Total     int             `json:"total"`
	Files     []GitStatusFile `json:"files"`
	// Dropped counts entries left out by the cap — a truncated list must not read as complete.
	Dropped int `json:"dropped"`
	// Submodules counts submodule pointers that moved. Counted separately because
	// a dirty submodule is invisible in the file list yet is exactly what makes a
	// "clean" checkout commit something unexpected.
	Submodules int `json:"submodules"`
}

// GitHead is where the checkout is standing.
type GitHead struct {
	Branch   *string `json:"branch"`
	Sha      *string `json:"sha"`
	Detached bool    `json:"detached"`
	Upstream *string `json:"upstream"`
	Ahead    *int    `json:"ahead"`
	Behind   *int    `json:"behind"`
}

// DiffFile is one patched file inside a commit or working-tree diff.
type DiffFile struct {
	Path    string     `json:"path"`
	OldPath *string    `json:"oldPath"`
	Status  DiffStatus `json:"status"`
	Add     int        `json:"add"`
	Del     int        `json:"del"`
	Binary  bool       `json:"binary"`
	// Truncated says the patch was clipped by the caps in consts_gen.go; the flag
	// keeps a partial patch honest.
	Truncated bool     `json:"truncated"`
	Lines     []string `json:"lines"`
}

// CommitDetail is the body and patch of one commit, produced on demand.
type CommitDetail struct {
	Sha           string     `json:"sha"`
	Subject       string     `json:"subject"`
	Body          string     `json:"body"`
	BodyTruncated bool       `json:"bodyTruncated"`
	Files         []DiffFile `json:"files"`
	// Dropped counts files left out by the byte cap — a count, so the UI can say how many.
	Dropped   int  `json:"dropped"`
	Truncated bool `json:"truncated"`
	// Empty records that a merge shown against its first parent has no patch.
	// Storing that fact is what stops it being recomputed on every single pass.
	Empty bool `json:"empty"`
	// AuthorEmail and the committer trio are ONLY what the graph row lacks: the
	// row already carries the author's name and date, and repeating them here pays
	// for the same bytes twice on the payload this contract was trimmed to keep
	// small. The committer usually equals the author — it differs after a rebase or
	// a cherry-pick, which is exactly when it is worth drawing.
	AuthorEmail    string `json:"authorEmail"`
	Committer      string `json:"committer"`
	CommitterEmail string `json:"committerEmail"`
	CommitterDate  *int64 `json:"committerDate"`
}

// WorkingDiff is the patch of the working tree, rewritten every pass.
type WorkingDiff struct {
	Staged    []DiffFile `json:"staged"`
	Unstaged  []DiffFile `json:"unstaged"`
	Untracked []DiffFile `json:"untracked"`
	Dropped   int        `json:"dropped"`
	Truncated bool       `json:"truncated"`
}

// GitRemoteRef is a ref as the REMOTE advertises it right now.
//
// ⚠ NOT GitRef, AND THE DIFFERENCE IS THE POINT. GitRef is a LOCAL pointer —
// including `refs/remotes/*`, which is a remote-TRACKING ref and therefore as old
// as the last fetch somebody ran. This one comes from asking the remote itself.
//
// ⚠ IT CARRIES A SHA AND NOT A DISTANCE. `ls-remote` downloads no objects, so
// "the local ref points somewhere else" is knowable and "you are three commits
// behind" is not.
type GitRemoteRef struct {
	Name string     `json:"name"`
	SHA  string     `json:"sha"`
	Kind RemoteKind `json:"kind"`
}

// RemoteKind is what the remote advertised: a branch or a tag.
type RemoteKind string

const (
	RemoteBranch RemoteKind = "branch"
	RemoteTag    RemoteKind = "tag"
)

// GitRemoteCheck is the result of one remote check, or the reason there is none.
type GitRemoteCheck struct {
	CheckedAt int64          `json:"checkedAt"`
	Refs      []GitRemoteRef `json:"refs"`
	// Error is set when the remote could not be reached — no remote, no network,
	// no credentials. A reachable remote with no refs is an empty list, not an error.
	Error *string `json:"error"`
}

// GitTreeEntry is one path in a repository as it stood at a commit.
type GitTreeEntry struct {
	Path string `json:"path"`
	// Size is the blob size in bytes, as `ls-tree --long` reports it.
	Size int `json:"size"`
}

// GitTree is a repository's whole file list at one commit.
//
// ⚠ NOT COLLECTED ON THE TIMER. The tree of a large checkout is thousands of
// paths and nobody has opened the commit; it arrives only because somebody
// clicked, the same way a remote check does.
type GitTree struct {
	SHA     string         `json:"sha"`
	Entries []GitTreeEntry `json:"entries"`
	// Dropped counts paths left out by the entry cap, so the UI can say how many.
	Dropped   int  `json:"dropped"`
	Truncated bool `json:"truncated"`
	// Error is set when the tree could not be read at all.
	Error *string `json:"error"`
}

// GitBlob is one file's contents at one commit.
//
// ⚠ Binary is an ANSWER, not a failure: a PNG has no lines to show, and sending
// its bytes to a browser that will render none of them is the payload this
// contract keeps trimming.
type GitBlob struct {
	SHA       string   `json:"sha"`
	Path      string   `json:"path"`
	Lines     []string `json:"lines"`
	Binary    bool     `json:"binary"`
	Truncated bool     `json:"truncated"`
	// Bytes is the size on disk, so "truncated" can say how much was left.
	Bytes int     `json:"bytes"`
	Error *string `json:"error"`
}

// FsEntry is one entry of a directory on this host.
//
// ⚠ Symlink is REPORTED, NOT RESOLVED. The agent browses through a root handle
// that cannot leave the home directory, so a link pointing outside it simply
// fails to open — and a reader who was not told it was a link reads that refusal
// as a bug. Saying so up front turns it into a fact about the file.
type FsEntry struct {
	Name    string `json:"name"`
	Dir     bool   `json:"dir"`
	Symlink bool   `json:"symlink"`
	Size    int    `json:"size"`
	// Modified is unix seconds, for a column that says how fresh something is.
	Modified int `json:"modified"`
}

// FsDir is one directory of this host, as it is right now.
//
// ⚠ Path IS RELATIVE TO THE HOME DIRECTORY, ALWAYS. The server never names a
// place on the disk: it names a path inside a root this agent opened for itself,
// and every name is resolved through that handle — so `..`, an absolute path and
// a symlink out of the tree are refused by construction rather than by a check.
//
// ⚠ AND UNLIKE A GIT TREE, THIS IS TRUE ONLY FOR AN INSTANT. A tree is immutable
// per sha and can be stored and re-served forever; this answers "what is there
// now" and must never be cached the same way.
type FsDir struct {
	// RequestID echoes the request's id.
	//
	// ⚠ CORRELATION CANNOT BE BY PATH, and that is the difference from a git tree.
	// A tree is immutable per sha, so any answer for a sha is the right one. A
	// directory is true for an instant: two reads of the same path a second apart
	// are different answers, and matching on the path alone would let a stale one
	// settle a newer request.
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
	// Home is the absolute home directory Path is relative to, for DISPLAY only.
	//
	// ⚠ NOTHING SENDS IT BACK. Requests stay relative to the root handle; this
	// exists so a path bar can show what `pwd` would print, and so a pasted
	// absolute path can be read as a place inside the home.
	Home    string    `json:"home"`
	Entries []FsEntry `json:"entries"`
	// Dropped counts entries left out by the cap, so the UI can say how many.
	Dropped   int  `json:"dropped"`
	Truncated bool `json:"truncated"`
	// Error is set when the directory could not be read at all, refusals included.
	Error *string `json:"error"`
}

// FsFile is one file from this host's disk, shaped like GitBlob for one viewer.
type FsFile struct {
	RequestID string   `json:"requestId"`
	Path      string   `json:"path"`
	Lines     []string `json:"lines"`
	Binary    bool     `json:"binary"`
	Truncated bool     `json:"truncated"`
	// Bytes is the size on disk, so "truncated" can say how much was left.
	Bytes int     `json:"bytes"`
	Error *string `json:"error"`
}

// FsChunk is one slice of a file, addressed by byte offset.
//
// ⚠ THE OFFSET IS WHY RESUME NEEDS NO STATE. Nothing is held between slices, so a
// download that stops halfway leaves nothing on the host and is resumed by asking
// for the next offset.
type FsChunk struct {
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
	Offset    int    `json:"offset"`
	// Data is base64. Empty at or past the end, which is not an error.
	Data string `json:"data"`
	// Size is the whole file, so a caller can set Content-Length from slice one.
	Size int `json:"size"`
	// EOF says nothing follows this slice.
	EOF   bool    `json:"eof"`
	Error *string `json:"error"`
}

// FsWrote is what a write did.
//
// ⚠ IT CARRIES NO CONTENT, EVER — not the bytes, not a preview. The MCP gateway
// states the same rule for command arguments; a file being uploaded is that
// surface exactly.
type FsWrote struct {
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
	// Written counts bytes accepted in THIS request.
	Written int `json:"written"`
	// Size is the file afterwards, so a caller can verify a sliced upload.
	Size  int     `json:"size"`
	Error *string `json:"error"`
}

// FsRemoved is what a delete did. `Removed` counts entries actually unlinked, so
// "nothing was there" and "one file went" stay different answers.
type FsRemoved struct {
	RequestID string  `json:"requestId"`
	Path      string  `json:"path"`
	Removed   int     `json:"removed"`
	Error     *string `json:"error"`
}

// RepoSnapshot is one checkout as of one collector pass.
type RepoSnapshot struct {
	// Path is the stable identity of the checkout on that host.
	Path string `json:"path"`
	// Name is the display name — the checkout's directory, or a submodule's path.
	Name    string      `json:"name"`
	Ts      int64       `json:"ts"`
	Head    GitHead     `json:"head"`
	Refs    []GitRef    `json:"refs"`
	Commits []GitCommit `json:"commits"`
	// Uncommitted is nil when the status could not be READ; an empty object means
	// it was read and the tree is clean. Collapsing the two loses the difference
	// between "unknown" and "nothing to do".
	Uncommitted *GitUncommitted `json:"uncommitted"`
	// Truncated is true when the window hid older history.
	Truncated bool `json:"truncated"`
	Limit     int  `json:"limit"`
	// Details are commit details produced in THIS pass (bounded by the server's budget).
	Details []CommitDetail `json:"details"`
	// WorkingDiff is nil once the tree is clean.
	WorkingDiff *WorkingDiff `json:"workingDiff"`
	// Pending counts commits in the window that still have no detail anywhere — the UI says so.
	Pending int `json:"pending"`
	// Partial is true when this frame answers a `commitDetail` request and carries
	// ONLY Details. Without it, replying to one click costs a full graph rebuild
	// (refs + every row) that the server already has.
	Partial bool    `json:"partial"`
	Error   *string `json:"error"`
	// Remote is the last remote check, or nil when nobody has asked for one. Never
	// filled by the periodic pass: it costs a network round trip per repository, so
	// it happens when a person presses the button and not on a timer.
	Remote *GitRemoteCheck `json:"remote"`
	// Tree and Blob answer a `fileTree` / `fileContent` request. Both are nil on
	// every other frame, and neither is ever filled by the periodic pass.
	Tree *GitTree `json:"tree"`
	Blob *GitBlob `json:"blob"`
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

// TerminalTarget is what a terminal attaches to.
type TerminalTarget struct {
	Kind TerminalKind `json:"kind"`
	// Session is the session name for Kind == TerminalSession; ignored for a shell.
	//
	// ⚠ THE PATTERN ON THIS FIELD IS A SECURITY CONTROL, NOT A TIDINESS RULE.
	// The value is interpolated into `tmux new -A -s <name>`, so the narrow class
	// (letters, digits, `_`, `-`, 1..32) is what stops a space splitting one
	// argument into two, a `;` starting a second command, `$(…)` substituting
	// before the outer command even runs, and `../` walking out of the state
	// directory. Widening it needs a different mechanism, not a longer class.
	//
	// It is also the second of the two genuine optionals: absent means absent,
	// hence the pointer and the only other `omitempty` in this package.
	Session *string `json:"session,omitempty"`
	Cols    int     `json:"cols"`
	Rows    int     `json:"rows"`
}

// ---------------------------------------------------------------------------
// Handshake, configuration and remote update
// ---------------------------------------------------------------------------

// AgentUpdateAbility says whether this host can be updated FROM the dashboard,
// and by what.
//
// A remote update ends with the agent replacing its own binary and exiting;
// something else has to start it again. Under systemd (`Restart=always`) or
// launchd (`KeepAlive`) that is free and needs no privileges. With no service
// manager — run from a terminal, or installed with `--no-service` — exiting is a
// hole the agent never climbs out of, so the server must know NOT to offer the
// button.
//
// WHY A NEW OBJECT AND NOT AN AgentCapability MEMBER: an unknown FIELD is
// stripped, an unknown ENUM VALUE is fatal. Growing this independently of old
// servers is only possible outside the enum.
type AgentUpdateAbility struct {
	CanRestart  bool        `json:"canRestart"`
	RestartMode RestartMode `json:"restartMode"`
}

// AgentHello is the first frame on every connection.
type AgentHello struct {
	ProtocolVersion int `json:"protocolVersion"`
	// AgentVersion is ⚠ FREE-FORM ON PURPOSE — do not tighten it to a SemVer
	// pattern. It is validated on the frame an ALREADY-INSTALLED agent sends: a
	// host reporting `0.1.0-dev+g1a2b3c` would fail the check, never reach the
	// registry, and disappear from the dashboard — and the fix for such a host is
	// the update button on the screen it just vanished from. Strictness belongs in
	// the reader (parse -> unknown), where being wrong costs a grey badge.
	AgentVersion string `json:"agentVersion"`
	Hostname     string `json:"hostname"`
	// Address is where this host can be reached, answered by the host ITSELF —
	// the server cannot work it out. What a server observes is the far end of the
	// socket and the agent dials OUT: measured on one deployment, one agent
	// arrives as `127.0.0.1` (same machine) and another as a container-bridge
	// address belonging to the reverse proxy. Neither is a way back. Empty is a
	// real answer and the contract defaults it, so an agent built before this
	// field simply reports nothing rather than failing `hello` and vanishing.
	Address      string            `json:"address"`
	OS           string            `json:"os"`
	Arch         string            `json:"arch"`
	Capabilities []AgentCapability `json:"capabilities"`
	// Update is absent from every agent built before remote update — the default says "no".
	Update AgentUpdateAbility `json:"update"`
}

// UpdateStatus is progress AND outcome of a remote update, in one type.
type UpdateStatus struct {
	// CommandID echoes AgentUpdate.CommandID, so a retry is recognisable as the same job.
	CommandID   string      `json:"commandId"`
	Phase       UpdatePhase `json:"phase"`
	ProgressPct *int        `json:"progressPct"`
	// CurrentVersion is what is running RIGHT NOW — authoritative, because the
	// stored row can be stale.
	CurrentVersion string  `json:"currentVersion"`
	TargetVersion  *string `json:"targetVersion"`
	// Code is a stable reason code (`SHA_MISMATCH`, `NOT_NEWER`, …) so a UI can group failures.
	Code    *string `json:"code"`
	Message string  `json:"message"`
	// ShellPanes and SessionPanes are sent with `accepted`, and are the reason the
	// confirmation dialog can talk in numbers: a restart terminates plain shells
	// and their children, while multiplexer sessions survive and re-attach.
	ShellPanes   int `json:"shellPanes"`
	SessionPanes int `json:"sessionPanes"`
}

// AgentServiceConfig is one port the server wants probed.
type AgentServiceConfig struct {
	ID    string    `json:"id"`
	Port  int       `json:"port"`
	Probe ProbeKind `json:"probe"`
	Path  string    `json:"path"`
}

// AgentConfig is how the server steers an agent that is already installed:
// intervals, which repos to watch, which ports to probe — none of it requires
// touching the host again.
type AgentConfig struct {
	HeartbeatSec   int `json:"heartbeatSec"`
	GitIntervalSec int `json:"gitIntervalSec"`
	// GitRoots are roots to scan for checkouts (the agent also walks one level of submodules).
	GitRoots []string `json:"gitRoots"`
	GitLimit int      `json:"gitLimit"`
	// GitDetailBudget is the max NEW commit details per repo per pass — this is
	// what bounds a cold start.
	GitDetailBudget int                  `json:"gitDetailBudget"`
	Services        []AgentServiceConfig `json:"services"`
	UsageProviders  []string             `json:"usageProviders"`
	// UsageIntervalSec is how often to re-read provider usage; it is far more
	// expensive than a heartbeat.
	UsageIntervalSec int `json:"usageIntervalSec"`
	// ProbeTimeoutMs is the per-service probe timeout — a hung port must not delay
	// the whole heartbeat.
	ProbeTimeoutMs int `json:"probeTimeoutMs"`
	// StatusFileCap caps `git status` entries reported for one repo.
	StatusFileCap int `json:"statusFileCap"`
	// BodyMaxChars caps a stored commit message body.
	BodyMaxChars int `json:"bodyMaxChars"`
	// TerminalBufferBytes is terminal output the agent may buffer per pane before
	// it drops oldest bytes.
	TerminalBufferBytes int `json:"terminalBufferBytes"`
}

// AgentUpdate is "replace yourself with this build".
//
// ⚠ THIS FRAME GRANTS NO NEW POWER, AND THAT IS A PROPERTY TO DEFEND, NOT A FACT
// TO ASSUME. A server that can open a PTY on a host can already run anything
// there, so remote update is a convenience over a capability it has. Two design
// choices are what keep it that way, and both must survive future edits:
//
//  1. ArtifactPath IS A PATH, NEVER A URL. The agent joins it onto the origin in
//     its own 0600 config — the one it authenticated to. Accepting an absolute
//     URL would turn one frame into "make every host in the fleet fetch
//     arbitrary bytes from an arbitrary host", using the fleet's egress
//     identity. That is a new capability (SSRF), not a convenience. If a CDN is
//     ever needed, it needs a HOST-side allow-list, so the host keeps the
//     decision.
//  2. THERE IS NO INSTALL-PATH FIELD, and none may be added. The agent swaps
//     os.Executable() and nothing else. A server-chosen destination is an
//     arbitrary-file-write primitive.
//
// SHA256 pins the bytes. Be honest about what that buys: the same server
// declares the hash and serves the bytes, so it defends against a corrupted or
// swapped static object — not against a compromised pdmux. Signature fields are
// deliberately absent rather than half-done; adding them later stays additive.
type AgentUpdate struct {
	// CommandID is an idempotency key. Re-sending the same id must not start a
	// second download.
	CommandID string `json:"commandId"`
	// Version is the SemVer of the target build. The agent refuses `<= own` unless Force.
	Version string `json:"version"`
	// ArtifactPath is a path under the agent's OWN server origin. See (1) above.
	//
	// The shape is pinned in the contract rather than only in the agent, so both
	// languages get it for free and a server bug is rejected at the boundary
	// instead of downloading: it must start with `/` (a bare `https://…` cannot
	// match, so no scheme), its second character may not be `/` (that is what
	// stops `//evil.example/x`, which is protocol-relative and would resolve
	// against ANOTHER HOST), and the class excludes `:`, `?`, `#`, `@` and
	// whitespace. Written without a lookahead on purpose: Go's RE2 has none, and a
	// pattern the two runtimes read differently is worse than a clumsier one.
	//
	// `..` still matches structurally; the agent rejects it separately. That is a
	// clarity rule, not a boundary — the request cannot leave our own origin either way.
	ArtifactPath string `json:"artifactPath"`
	// SHA256 is lower-case hex. This one IS pattern-checked, unlike AgentVersion:
	// a malformed hash is never a compatibility question, always a bug, and the
	// field is new enough that no deployed agent has an opinion about it.
	SHA256 string `json:"sha256"`
	// Bytes is the exact size; also the agent's read cap, so a truncated or
	// endless body stops.
	Bytes int64 `json:"bytes"`
	// OS and Arch are echoed so the agent can refuse a build for the wrong machine
	// before running it.
	OS   string `json:"os"`
	Arch string `json:"arch"`
	// Force permits a deliberate downgrade. Still fully gated by verify-then-commit.
	Force bool `json:"force"`
	// ProbationSec is how long the new binary has to complete a handshake before
	// it rolls itself back.
	ProbationSec int `json:"probationSec"`
}

// AgentExec is one command to run on this host, non-interactively.
//
// WHY IT IS NOT A TERMINAL: a PTY hands back the shell's prompt, its echo and
// ANSI, and no exit status. A caller that has to decide whether a build passed
// cannot do it from that stream. This frame gives up interactivity to get an
// answer.
//
// ⚠ COMMAND AND ARGS ARE SEPARATE, AND NO SHELL IS INVOLVED. A single string
// would have to reach `sh -c`, and then one unquoted argument runs a second
// command. `sys.Run` takes file + args, so metacharacters stay characters.
type AgentExec struct {
	// CommandID is the server's id for this run; the result echoes it.
	CommandID string `json:"commandId"`
	// Command is a binary name or an absolute path, resolved on this host.
	Command string   `json:"command"`
	Args    []string `json:"args"`
	// Cwd is null for the agent's own working directory. A pointer because the
	// empty string is a different statement ("run in the root of nothing") and the
	// two must not collapse into one another.
	Cwd *string `json:"cwd"`
	// TimeoutMs is bounded by the contract on both ends: unbounded is how one call
	// holds a slot forever.
	TimeoutMs int `json:"timeoutMs"`
}

// ExecResult is the outcome of one AgentExec.
//
// ExitCode carries sys.Run's own convention through rather than translating it:
// -1 means killed or never started. TimedOut separates "we stopped it" from "it
// failed", and Code carries a stable reason when the command never ran at all.
type ExecResult struct {
	CommandID string `json:"commandId"`
	ExitCode  int    `json:"exitCode"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	// Truncated says either stream hit ExecOutputMax and was cut, so a reader is
	// never left wondering whether the output really stopped mid-line.
	Truncated bool `json:"truncated"`
	TimedOut  bool `json:"timedOut"`
	// Code is null when the command actually ran; a string when the agent refused
	// before running (COMMAND_NOT_FOUND). A pointer because null is load-bearing —
	// an empty string would claim there was a reason and that it was blank.
	Code    *string `json:"code"`
	Message string  `json:"message"`
}

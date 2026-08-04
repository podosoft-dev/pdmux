package protocol

// The four discriminated unions, and the only place that knows how to turn
// bytes into one of their branches.
//
// ⚠ THE DISCRIMINATOR IS NOT IN THE SCHEMA. In zod these are
// `z.discriminatedUnion('type', …)`, and that name survives generation only as
// `properties.type.const` on every branch — a JSON-Schema validator will happily
// tell you "none of the 6 branches matched" and never mention which key decides.
// So the reader does it explicitly: read `type`, decode THAT branch, and fail
// with the offending value when it names no branch.
//
// AN UNKNOWN TYPE IS AN ERROR, WHILE AN UNKNOWN FIELD IS IGNORED. That asymmetry
// is deliberate: a newer peer adding a field must keep working against this
// build (encoding/json drops it, matching zod's `strip`), but a frame this build
// cannot act on must not be half-executed. The caller logs it and keeps the
// connection — the one thing you must always be able to say to a broken agent is
// "update yourself".
//
// A NOTE ON THE `stampXxx` METHODS: each branch's union method STAMPS its own
// discriminator and returns it. Encoding calls it, so a frame built as a plain
// struct literal cannot go out with `"type":""`. The method is unexported, which
// also closes the union — only this package can add a branch, exactly like zod's
// closed list.

import (
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------------
// Discriminator values
// ---------------------------------------------------------------------------

// UpstreamType discriminates agent -> server frames.
type UpstreamType string

const (
	UpstreamHello        UpstreamType = "hello"
	UpstreamHeartbeat    UpstreamType = "heartbeat"
	UpstreamRepos        UpstreamType = "repos"
	UpstreamTerminal     UpstreamType = "terminal"
	UpstreamPong         UpstreamType = "pong"
	UpstreamUpdateStatus UpstreamType = "updateStatus"
	UpstreamExecResult   UpstreamType = "execResult"
)

// DownstreamType discriminates server -> agent frames.
type DownstreamType string

const (
	DownstreamWelcome      DownstreamType = "welcome"
	DownstreamConfig       DownstreamType = "config"
	DownstreamUpdate       DownstreamType = "update"
	DownstreamTerminal     DownstreamType = "terminal"
	DownstreamPing         DownstreamType = "ping"
	DownstreamCollect      DownstreamType = "collect"
	DownstreamCommitDetail DownstreamType = "commitDetail"
	DownstreamDetailAck    DownstreamType = "detailAck"
	DownstreamFileTree     DownstreamType = "fileTree"
	DownstreamFileContent  DownstreamType = "fileContent"
	DownstreamExec         DownstreamType = "exec"
)

// TerminalServerType discriminates agent -> server -> browser terminal frames.
type TerminalServerType string

const (
	TermReady  TerminalServerType = "ready"
	TermOutput TerminalServerType = "output"
	TermExit   TerminalServerType = "exit"
	TermError  TerminalServerType = "error"
)

// TerminalClientType discriminates browser -> server -> agent terminal frames.
type TerminalClientType string

const (
	TermOpen   TerminalClientType = "open"
	TermInput  TerminalClientType = "input"
	TermResize TerminalClientType = "resize"
	TermClose  TerminalClientType = "close"
)

// ---------------------------------------------------------------------------
// Union interfaces
// ---------------------------------------------------------------------------

// UpstreamFrame is one branch of the agent -> server union. The method is
// unexported on purpose: no package outside this one can add a branch, which is
// what makes a type switch over the branches exhaustive by construction.
type UpstreamFrame interface {
	stampUpstream() UpstreamType
}

// DownstreamFrame is one branch of the server -> agent union.
type DownstreamFrame interface {
	stampDownstream() DownstreamType
}

// TerminalServerFrame is one branch of the agent -> browser terminal union.
type TerminalServerFrame interface {
	stampTerminalServer() TerminalServerType
}

// TerminalClientFrame is one branch of the browser -> agent terminal union.
type TerminalClientFrame interface {
	stampTerminalClient() TerminalClientType
}

// ---------------------------------------------------------------------------
// Agent -> server branches
// ---------------------------------------------------------------------------

// HelloFrame introduces the agent. It is sent the instant the socket opens.
type HelloFrame struct {
	Type  UpstreamType `json:"type"`
	Hello AgentHello   `json:"hello"`
}

// HeartbeatFrame carries every value a host card draws, in one pass.
type HeartbeatFrame struct {
	Type      UpstreamType `json:"type"`
	Heartbeat Heartbeat    `json:"heartbeat"`
}

// ReposFrame is the read-only git snapshot for every watched checkout.
type ReposFrame struct {
	Type  UpstreamType   `json:"type"`
	Ts    int64          `json:"ts"`
	Repos []RepoSnapshot `json:"repos"`
}

// TerminalUpstream wraps one PTY frame on its way to the browser.
type TerminalUpstream struct {
	Type  UpstreamType        `json:"type"`
	Frame TerminalServerFrame `json:"frame"`
}

// PongFrame answers a PingFrame.
type PongFrame struct {
	Type UpstreamType `json:"type"`
	Ts   int64        `json:"ts"`
}

// UpdateStatusFrame reports progress and outcome of a remote update.
type UpdateStatusFrame struct {
	Type   UpstreamType `json:"type"`
	Update UpdateStatus `json:"update"`
}

// ExecResultFrame carries the outcome of one command back to the server.
type ExecResultFrame struct {
	Type   UpstreamType `json:"type"`
	Result ExecResult   `json:"result"`
}

func (f *HelloFrame) stampUpstream() UpstreamType {
	f.Type = UpstreamHello
	return UpstreamHello
}

func (f *HeartbeatFrame) stampUpstream() UpstreamType {
	f.Type = UpstreamHeartbeat
	return UpstreamHeartbeat
}

func (f *ReposFrame) stampUpstream() UpstreamType {
	f.Type = UpstreamRepos
	return UpstreamRepos
}

func (f *TerminalUpstream) stampUpstream() UpstreamType {
	f.Type = UpstreamTerminal
	return UpstreamTerminal
}

func (f *PongFrame) stampUpstream() UpstreamType {
	f.Type = UpstreamPong
	return UpstreamPong
}

func (f *ExecResultFrame) stampUpstream() UpstreamType {
	f.Type = UpstreamExecResult
	return UpstreamExecResult
}

func (f *UpdateStatusFrame) stampUpstream() UpstreamType {
	f.Type = UpstreamUpdateStatus
	return UpstreamUpdateStatus
}

// ---------------------------------------------------------------------------
// Server -> agent branches
// ---------------------------------------------------------------------------

// WelcomeFrame answers a HelloFrame and hands the agent its identity and config.
type WelcomeFrame struct {
	Type   DownstreamType `json:"type"`
	HostID string         `json:"hostId"`
	Config AgentConfig    `json:"config"`
	// ServerVersion is the server's own SemVer. Advisory — logged by the agent, never a gate.
	ServerVersion string `json:"serverVersion"`
	// TokenExpiresAt is when the credential this connection was accepted with stops
	// working, RFC 3339, or nil for one that never does.
	//
	// ⚠ A POINTER BECAUSE "NEVER" AND "UNKNOWN" ARE BOTH REAL. A token minted
	// without an expiry has none, and a server too old to send the field says
	// nothing — neither is a date, and a zero value would render as one. It is the
	// server's answer about its own row; the agent only records it, so that
	// `instances` can say a credential is about to lapse before it does rather
	// than after, when the only symptom is a 401 that looks like every other 401.
	TokenExpiresAt *string `json:"tokenExpiresAt,omitempty"`
}

// ConfigFrame re-steers an already-connected agent without a reconnect.
type ConfigFrame struct {
	Type   DownstreamType `json:"type"`
	Config AgentConfig    `json:"config"`
}

// UpdateFrame asks the agent to replace its own binary.
type UpdateFrame struct {
	Type   DownstreamType `json:"type"`
	Update AgentUpdate    `json:"update"`
}

// ExecFrame asks the agent to run one command and report how it went.
type ExecFrame struct {
	Type DownstreamType `json:"type"`
	Exec AgentExec      `json:"exec"`
}

// TerminalDownstream wraps one browser terminal frame on its way to the PTY.
type TerminalDownstream struct {
	Type  DownstreamType      `json:"type"`
	Frame TerminalClientFrame `json:"frame"`
}

// PingFrame is the server's liveness probe.
type PingFrame struct {
	Type DownstreamType `json:"type"`
	Ts   int64          `json:"ts"`
}

// CollectFrame asks for one immediate pass, so "refresh" does not wait out the interval.
type CollectFrame struct {
	Type DownstreamType `json:"type"`
	What CollectWhat    `json:"what"`
}

// CommitDetailFrame asks for the body and patch of specific commits — the frame
// a click on the graph produces.
type CommitDetailFrame struct {
	Type     DownstreamType `json:"type"`
	RepoPath string         `json:"repoPath"`
	Shas     []string       `json:"shas"`
}

// FileTreeFrame asks which paths existed at one commit.
//
// ⚠ SEPARATE FROM FileContentFrame ON PURPOSE. A tree is one `ls-tree` and a blob
// is one `show` per click; folded into one frame, opening a second file in the
// same commit would re-read the whole tree.
type FileTreeFrame struct {
	Type     DownstreamType `json:"type"`
	RepoPath string         `json:"repoPath"`
	SHA      string         `json:"sha"`
}

// FileContentFrame asks for one file's contents at one commit.
type FileContentFrame struct {
	Type     DownstreamType `json:"type"`
	RepoPath string         `json:"repoPath"`
	SHA      string         `json:"sha"`
	Path     string         `json:"path"`
}

// DetailAckFrame says "I have these". Details are immutable per sha, so an agent
// that knows what the server already stored never rebuilds them — without this, a
// restarted agent spends its whole per-pass budget re-producing patches the
// server has.
type DetailAckFrame struct {
	Type     DownstreamType `json:"type"`
	RepoPath string         `json:"repoPath"`
	Shas     []string       `json:"shas"`
}

func (f *WelcomeFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamWelcome
	return DownstreamWelcome
}

func (f *ConfigFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamConfig
	return DownstreamConfig
}

func (f *UpdateFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamUpdate
	return DownstreamUpdate
}

func (f *ExecFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamExec
	return DownstreamExec
}

func (f *TerminalDownstream) stampDownstream() DownstreamType {
	f.Type = DownstreamTerminal
	return DownstreamTerminal
}

func (f *PingFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamPing
	return DownstreamPing
}

func (f *CollectFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamCollect
	return DownstreamCollect
}

func (f *CommitDetailFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamCommitDetail
	return DownstreamCommitDetail
}

func (f *FileTreeFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamFileTree
	return DownstreamFileTree
}

func (f *FileContentFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamFileContent
	return DownstreamFileContent
}

func (f *DetailAckFrame) stampDownstream() DownstreamType {
	f.Type = DownstreamDetailAck
	return DownstreamDetailAck
}

// ---------------------------------------------------------------------------
// Terminal branches
// ---------------------------------------------------------------------------

// TerminalReady says the PTY is up.
type TerminalReady struct {
	Type   TerminalServerType `json:"type"`
	TermID string             `json:"termId"`
	Pid    *int               `json:"pid"`
}

// TerminalOutput is a burst of PTY output, already coalesced by the producer.
type TerminalOutput struct {
	Type   TerminalServerType `json:"type"`
	TermID string             `json:"termId"`
	Data   string             `json:"data"`
	// Dropped is bytes the producer had to discard to stay under its buffer cap.
	// A runaway command (a build log, `yes`) outruns any consumer; dropping is the
	// only option left, and saying how much keeps the pane honest instead of
	// silently corrupting the stream.
	Dropped int `json:"dropped"`
}

// TerminalExit reports the shell's exit code (nil when it was signalled).
type TerminalExit struct {
	Type   TerminalServerType `json:"type"`
	TermID string             `json:"termId"`
	Code   *int               `json:"code"`
}

// TerminalError reports a failure to open or keep a PTY.
type TerminalError struct {
	Type    TerminalServerType `json:"type"`
	TermID  string             `json:"termId"`
	Message string             `json:"message"`
}

func (f *TerminalReady) stampTerminalServer() TerminalServerType {
	f.Type = TermReady
	return TermReady
}

func (f *TerminalOutput) stampTerminalServer() TerminalServerType {
	f.Type = TermOutput
	return TermOutput
}

func (f *TerminalExit) stampTerminalServer() TerminalServerType {
	f.Type = TermExit
	return TermExit
}

func (f *TerminalError) stampTerminalServer() TerminalServerType {
	f.Type = TermError
	return TermError
}

// TerminalOpen asks for a PTY attached to a session or a bare shell.
type TerminalOpen struct {
	Type   TerminalClientType `json:"type"`
	TermID string             `json:"termId"`
	Target TerminalTarget     `json:"target"`
}

// TerminalInput is keystrokes.
type TerminalInput struct {
	Type   TerminalClientType `json:"type"`
	TermID string             `json:"termId"`
	Data   string             `json:"data"`
}

// TerminalResize changes what the shell believes its window is.
type TerminalResize struct {
	Type   TerminalClientType `json:"type"`
	TermID string             `json:"termId"`
	Cols   int                `json:"cols"`
	Rows   int                `json:"rows"`
}

// TerminalClose tears the pane down.
type TerminalClose struct {
	Type   TerminalClientType `json:"type"`
	TermID string             `json:"termId"`
}

func (f *TerminalOpen) stampTerminalClient() TerminalClientType {
	f.Type = TermOpen
	return TermOpen
}

func (f *TerminalInput) stampTerminalClient() TerminalClientType {
	f.Type = TermInput
	return TermInput
}

func (f *TerminalResize) stampTerminalClient() TerminalClientType {
	f.Type = TermResize
	return TermResize
}

func (f *TerminalClose) stampTerminalClient() TerminalClientType {
	f.Type = TermClose
	return TermClose
}

// ---------------------------------------------------------------------------
// Constructors for the branches that carry a slice
//
// A nil Go slice marshals to `null`, and zod's `.default([])` only fills
// `undefined` — so a struct literal that leaves one of these nil produces a
// frame the server rejects whole. These exist so the caller never has to
// remember that.
// ---------------------------------------------------------------------------

// NewReposFrame returns a repos frame with an empty (not nil) repo list.
func NewReposFrame(ts int64) *ReposFrame {
	return &ReposFrame{Type: UpstreamRepos, Ts: ts, Repos: []RepoSnapshot{}}
}

// NewCommitDetailFrame returns a commitDetail request with an empty sha list.
func NewCommitDetailFrame(repoPath string) *CommitDetailFrame {
	return &CommitDetailFrame{Type: DownstreamCommitDetail, RepoPath: repoPath, Shas: []string{}}
}

// NewDetailAckFrame returns a detailAck with an empty sha list.
func NewDetailAckFrame(repoPath string) *DetailAckFrame {
	return &DetailAckFrame{Type: DownstreamDetailAck, RepoPath: repoPath, Shas: []string{}}
}

// ---------------------------------------------------------------------------
// Decoding
//
// These are the UNCHECKED readers: they assume the bytes already passed the
// schema (validate.go is the only exported way in, and it validates first).
// That is what lets them treat a missing required field as a decode error
// rather than as a shape they have to guess at.
// ---------------------------------------------------------------------------

// discriminator reads just the `type` key. It is read before anything else
// because the schema cannot say which key decides — see the file header.
func discriminator(raw []byte) (string, error) {
	var probe struct {
		Type *string `json:"type"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return "", fmt.Errorf("frame is not a JSON object with a string `type`: %w", err)
	}
	if probe.Type == nil {
		return "", fmt.Errorf("frame has no `type` discriminator")
	}
	return *probe.Type, nil
}

// Each reader below has the same three steps — pick the branch from `type`,
// unmarshal into it, stamp the discriminator — and the switch is deliberately
// nothing but the branch table, so "which types are in this union" is one
// readable list rather than logic.

func decodeUpstream(raw []byte) (UpstreamFrame, error) {
	kind, err := discriminator(raw)
	if err != nil {
		return nil, err
	}
	var frame UpstreamFrame
	switch UpstreamType(kind) {
	case UpstreamHello:
		frame = new(HelloFrame)
	case UpstreamHeartbeat:
		frame = new(HeartbeatFrame)
	case UpstreamRepos:
		frame = new(ReposFrame)
	case UpstreamTerminal:
		frame = new(TerminalUpstream)
	case UpstreamPong:
		frame = new(PongFrame)
	case UpstreamUpdateStatus:
		frame = new(UpdateStatusFrame)
	case UpstreamExecResult:
		frame = new(ExecResultFrame)
	default:
		return nil, fmt.Errorf("unknown upstream frame type %q", kind)
	}
	if err := json.Unmarshal(raw, frame); err != nil {
		return nil, fmt.Errorf("%s frame: %w", kind, err)
	}
	frame.stampUpstream()
	return frame, nil
}

func decodeDownstream(raw []byte) (DownstreamFrame, error) {
	kind, err := discriminator(raw)
	if err != nil {
		return nil, err
	}
	var frame DownstreamFrame
	switch DownstreamType(kind) {
	case DownstreamWelcome:
		frame = new(WelcomeFrame)
	case DownstreamConfig:
		frame = new(ConfigFrame)
	case DownstreamUpdate:
		frame = new(UpdateFrame)
	case DownstreamExec:
		frame = new(ExecFrame)
	case DownstreamTerminal:
		frame = new(TerminalDownstream)
	case DownstreamPing:
		frame = new(PingFrame)
	case DownstreamCollect:
		frame = new(CollectFrame)
	case DownstreamCommitDetail:
		frame = new(CommitDetailFrame)
	case DownstreamDetailAck:
		frame = new(DetailAckFrame)
	case DownstreamFileTree:
		frame = new(FileTreeFrame)
	case DownstreamFileContent:
		frame = new(FileContentFrame)
	default:
		return nil, fmt.Errorf("unknown downstream frame type %q", kind)
	}
	if err := json.Unmarshal(raw, frame); err != nil {
		return nil, fmt.Errorf("%s frame: %w", kind, err)
	}
	frame.stampDownstream()
	return frame, nil
}

func decodeTerminalServer(raw []byte) (TerminalServerFrame, error) {
	kind, err := discriminator(raw)
	if err != nil {
		return nil, err
	}
	var frame TerminalServerFrame
	switch TerminalServerType(kind) {
	case TermReady:
		frame = new(TerminalReady)
	case TermOutput:
		frame = new(TerminalOutput)
	case TermExit:
		frame = new(TerminalExit)
	case TermError:
		frame = new(TerminalError)
	default:
		return nil, fmt.Errorf("unknown terminal server frame type %q", kind)
	}
	if err := json.Unmarshal(raw, frame); err != nil {
		return nil, fmt.Errorf("%s frame: %w", kind, err)
	}
	frame.stampTerminalServer()
	return frame, nil
}

func decodeTerminalClient(raw []byte) (TerminalClientFrame, error) {
	kind, err := discriminator(raw)
	if err != nil {
		return nil, err
	}
	var frame TerminalClientFrame
	switch TerminalClientType(kind) {
	case TermOpen:
		frame = new(TerminalOpen)
	case TermInput:
		frame = new(TerminalInput)
	case TermResize:
		frame = new(TerminalResize)
	case TermClose:
		frame = new(TerminalClose)
	default:
		return nil, fmt.Errorf("unknown terminal client frame type %q", kind)
	}
	if err := json.Unmarshal(raw, frame); err != nil {
		return nil, fmt.Errorf("%s frame: %w", kind, err)
	}
	frame.stampTerminalClient()
	return frame, nil
}

// UnmarshalJSON decodes the nested terminal union by hand: encoding/json cannot
// fill an interface-typed field, so the wrapper reads the inner frame as raw
// bytes and hands them to the union's own reader.
func (f *TerminalUpstream) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type  UpstreamType    `json:"type"`
		Frame json.RawMessage `json:"frame"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	inner, err := decodeTerminalServer(wire.Frame)
	if err != nil {
		return fmt.Errorf("terminal frame: %w", err)
	}
	f.Type, f.Frame = wire.Type, inner
	return nil
}

// UnmarshalJSON decodes the nested terminal union — see TerminalUpstream.
func (f *TerminalDownstream) UnmarshalJSON(data []byte) error {
	var wire struct {
		Type  DownstreamType  `json:"type"`
		Frame json.RawMessage `json:"frame"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	inner, err := decodeTerminalClient(wire.Frame)
	if err != nil {
		return fmt.Errorf("terminal frame: %w", err)
	}
	f.Type, f.Frame = wire.Type, inner
	return nil
}

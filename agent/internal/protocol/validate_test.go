package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The upstream artefacts, read by relative path. The schema is MIRRORED into the
// package (it is needed at runtime, on a machine where this repo does not exist);
// these reads exist only to prove the mirror is current.
const contractDir = "../../../packages/protocol/schema"

func TestEmbeddedContract(t *testing.T) {
	t.Run("[TC-PDAGENT-048] the embedded contract is the committed contract", func(t *testing.T) {
		// The tripwire for the failure nothing else can see: zod is edited, the JSON
		// artefacts are regenerated, and `go generate ./...` is not re-run. The agent
		// would then validate against a stale contract and disagree with the server
		// about a field neither of them mentions.
		for _, file := range []struct {
			name string
			pin  string
		}{
			{"protocol.schema.json", SchemaSHA256},
			{"constants.json", ConstantsSHA256},
		} {
			data, err := os.ReadFile(filepath.Join(contractDir, file.name))
			if err != nil {
				t.Fatalf("reading %s: %v", file.name, err)
			}
			sum := sha256.Sum256(data)
			if got := hex.EncodeToString(sum[:]); got != file.pin {
				t.Errorf("%s has changed (%s, pinned %s) — run `go generate ./internal/protocol`", file.name, got, file.pin)
			}
		}

		upstream, err := os.ReadFile(filepath.Join(contractDir, "protocol.schema.json"))
		if err != nil {
			t.Fatal(err)
		}
		if string(SchemaJSON()) != string(upstream) {
			t.Error("the embedded schema mirror differs from packages/protocol/schema/protocol.schema.json")
		}
	})

	t.Run("[TC-PDAGENT-048] the contract constants match the values compiled in", func(t *testing.T) {
		// These are the values a schema cannot express, so nothing else checks them:
		// an agent that dials the wrong path or sends the wrong header never connects
		// at all, and the symptom is "the host is missing", not "the frame is wrong".
		data, err := os.ReadFile(filepath.Join(contractDir, "constants.json"))
		if err != nil {
			t.Fatal(err)
		}
		var constants struct {
			AgentKeyHeader  string `json:"AGENT_KEY_HEADER"`
			AgentWSPath     string `json:"AGENT_WS_PATH"`
			TerminalWSPath  string `json:"TERMINAL_WS_PATH"`
			ProtocolVersion int    `json:"PROTOCOL_VERSION"`
			DiffCaps        struct {
				MaxBytes     int `json:"maxBytes"`
				MaxFileLines int `json:"maxFileLines"`
				MaxLineChars int `json:"maxLineChars"`
			} `json:"DIFF_CAPS"`
		}
		if err := json.Unmarshal(data, &constants); err != nil {
			t.Fatal(err)
		}
		checks := []struct {
			name      string
			got, want any
		}{
			{"AGENT_KEY_HEADER", AgentKeyHeader, constants.AgentKeyHeader},
			{"AGENT_WS_PATH", AgentWSPath, constants.AgentWSPath},
			{"TERMINAL_WS_PATH", TerminalWSPath, constants.TerminalWSPath},
			{"PROTOCOL_VERSION", ProtocolVersion, constants.ProtocolVersion},
			{"DIFF_CAPS.maxBytes", DiffCapsMaxBytes, constants.DiffCaps.MaxBytes},
			{"DIFF_CAPS.maxFileLines", DiffCapsMaxFileLines, constants.DiffCaps.MaxFileLines},
			{"DIFF_CAPS.maxLineChars", DiffCapsMaxLineChars, constants.DiffCaps.MaxLineChars},
		}
		for _, check := range checks {
			if check.got != check.want {
				t.Errorf("%s = %v, want %v", check.name, check.got, check.want)
			}
		}
	})
}

func TestRuntimeValidation(t *testing.T) {
	t.Run("[TC-PDAGENT-048] format: uuid is asserted, not just annotated", func(t *testing.T) {
		// Five fields carry `format: uuid`, and they are all joins — hostId keys
		// everything the agent stores. With format assertions off, `format` is a
		// comment and a free-form string sails through, so this is the check that
		// proves AssertFormat() is actually wired.
		const template = `{"type":"welcome","hostId":%q,"config":{}}`
		if err := ValidateDownstream(fmt.Appendf(nil, template, "9f2c1e34-5b6a-4c7d-8e9f-0a1b2c3d4e5f")); err != nil {
			t.Fatalf("a real uuid was rejected: %v", err)
		}
		err := ValidateDownstream(fmt.Appendf(nil, template, "host-one"))
		if err == nil {
			t.Fatal("a hostId that is not a uuid was accepted — format assertions are off")
		}
		if !errors.Is(err, ErrInvalidFrame) {
			t.Errorf("error does not wrap ErrInvalidFrame: %v", err)
		}
	})

	t.Run("[TC-PDAGENT-048] outbound terminal frames skip validation, everything else is checked", func(t *testing.T) {
		// Terminal frames arrive dozens of times a second and their shape is
		// produced locally, so checking them would be pure overhead on the agent's
		// hottest path. The exemption has to be provable, or it is just a comment:
		// the SAME over-long message is refused in a non-terminal frame and let
		// through in a terminal one.
		tooLong := strings.Repeat("x", 513)

		terminal := &TerminalUpstream{Frame: &TerminalError{TermID: "t-1", Message: tooLong}}
		if _, err := EncodeUpstream(terminal); err != nil {
			t.Errorf("a terminal frame was validated on the way out: %v", err)
		}

		heartbeat := &HeartbeatFrame{Heartbeat: NewHeartbeat()}
		heartbeat.Heartbeat.Ts = 1784000000
		diagnostic := NewAgentDiagnostic()
		diagnostic.Code = "git.missing"
		diagnostic.Message = tooLong
		heartbeat.Heartbeat.Diagnostics = append(heartbeat.Heartbeat.Diagnostics, diagnostic)
		if _, err := EncodeUpstream(heartbeat); err == nil {
			t.Error("a diagnostic message over the 512-character cap was sent")
		} else if !errors.Is(err, ErrInvalidFrame) {
			t.Errorf("error does not wrap ErrInvalidFrame: %v", err)
		}
	})

	t.Run("[TC-PDAGENT-048] encoding stamps the discriminator the schema cannot describe", func(t *testing.T) {
		// `type` is zod's discriminator, and it survives generation only as a
		// per-branch `const`. A frame built as a plain struct literal must still go
		// out with it — otherwise the server sees `"type":""` and matches no branch.
		encoded, err := EncodeUpstream(&PongFrame{Ts: 1784000000})
		if err != nil {
			t.Fatalf("encoding: %v", err)
		}
		var frame struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(encoded, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type != string(UpstreamPong) {
			t.Errorf("type = %q, want %q", frame.Type, UpstreamPong)
		}
	})

	t.Run("[TC-PDAGENT-007] an invalid downstream frame is dropped, never fatal", func(t *testing.T) {
		// One bad message from a half-upgraded server must not take down a
		// connection that is otherwise fine — and must certainly not crash the
		// daemon. Every input here returns an error and leaves the reader usable.
		bad := []struct {
			name  string
			frame string
		}{
			{"not JSON at all", `{"type":`},
			{"a JSON array", `[1,2,3]`},
			{"no discriminator", `{"config":{}}`},
			{"a frame type this build does not know", `{"type":"reboot","when":"now"}`},
			{"a heartbeat interval of zero, which would be a busy loop", `{"type":"config","config":{"heartbeatSec":0}}`},
			{"a git limit that asks for the whole history", `{"type":"config","config":{"gitLimit":99999}}`},
			{"a session name with a shell metacharacter", `{"type":"terminal","frame":{"type":"open","termId":"t","target":{"session":"a;b"}}}`},
			{"an artifact path that is protocol-relative", `{"type":"update","update":{"commandId":"7c9e6679-7425-40de-944b-e07fc1f90ae7","version":"1.0.0","artifactPath":"//evil.example/x","sha256":"` + strings.Repeat("a", 64) + `","bytes":1,"os":"linux","arch":"amd64"}}`},
		}
		for _, input := range bad {
			frame, err := DecodeDownstream([]byte(input.frame))
			if err == nil {
				t.Errorf("%s: accepted %s", input.name, input.frame)
				continue
			}
			if frame != nil {
				t.Errorf("%s: returned a frame alongside an error", input.name)
			}
		}

		// The reader still works afterwards: dropping is a per-frame decision.
		if _, err := DecodeDownstream([]byte(`{"type":"ping","ts":1784000000}`)); err != nil {
			t.Errorf("a good frame after eight bad ones failed: %v", err)
		}
	})

	t.Run("[TC-PDAGENT-008] an upstream frame that breaks the contract is refused before it is sent", func(t *testing.T) {
		// Catching it here names the producer. Letting it out means the server
		// silently drops the frame and the symptom appears on someone else's screen
		// as a host that never registered.
		nilSlices := &HelloFrame{Hello: AgentHello{
			ProtocolVersion: ProtocolVersion,
			AgentVersion:    "0.1.0",
			Hostname:        "build-01",
			OS:              "linux",
			Arch:            "amd64",
			// Capabilities left nil: it marshals to `null`, and `.default([])` only
			// fills `undefined`. The whole hello is rejected and the host never appears.
		}}
		if _, err := EncodeUpstream(nilSlices); err == nil {
			t.Error("a hello with a nil capabilities slice was sent")
		} else if !errors.Is(err, ErrInvalidFrame) {
			t.Errorf("error does not wrap ErrInvalidFrame: %v", err)
		}

		// The same frame built through the constructor is fine — which is the point
		// of the constructors existing.
		hello := NewAgentHello()
		hello.ProtocolVersion = ProtocolVersion
		hello.AgentVersion = "0.1.0"
		hello.Hostname = "build-01"
		hello.OS = "linux"
		hello.Arch = "amd64"
		if _, err := EncodeUpstream(&HelloFrame{Hello: hello}); err != nil {
			t.Errorf("a hello built through NewAgentHello was refused: %v", err)
		}

		// A fractional percentage is the other frame a naive port emits by
		// accident: Go reads CPU as a float64 and `percent` is an integer.
		fractional := &HeartbeatFrame{Heartbeat: NewHeartbeat()}
		fractional.Heartbeat.Ts = 1784000000
		fractional.Heartbeat.Resource.CPUPct = nil
		raw := []byte(`{"type":"heartbeat","heartbeat":{"ts":1784000000,"resource":{"cpuPct":42.5}}}`)
		if err := ValidateUpstream(raw); err == nil {
			t.Error("a fractional cpuPct was accepted")
		}
	})
}

package protocol

// Runtime validation against the contract, and the only exported way in or out.
//
// WHY VALIDATE AT ALL WHEN THE STRUCTS ARE TYPED: the structs say what the
// fields ARE, not what they may CONTAIN. `percent` is 0..100, `heartbeatSec` is
// 1..3600, `hostId` is a uuid, `artifactPath` may not start with `//`. Every one
// of those is a bound a Go type cannot express, several of them are security
// controls, and all of them are already stated once — in the zod contract, which
// is generated into the schema embedded below. Re-stating them in Go code is how
// the two drift.
//
// INBOUND IS ALWAYS CHECKED, AND A FAILURE IS A DROP — NOT A FATAL. One bad
// message from a half-upgraded server must not take down a connection that is
// otherwise fine, and must certainly not crash the daemon; the caller logs the
// error and reads the next frame. This mirrors apps/agent/src/net/client.ts,
// where `handleMessage` discards and returns.
//
// OUTBOUND IS CHECKED TOO, EXCEPT TERMINAL FRAMES. Validating what we send
// catches the whole class of "the agent built a frame the server silently
// rejects" — a nil slice that marshals to `null`, a float CPU reading, a
// zero-valued `limit` — at the point where the stack trace still names the
// producer. Terminal frames are exempt because they arrive dozens of times a
// second and their shape is produced locally, so the check would be pure
// overhead on the hottest path in the agent. Same exemption, same reason, as
// `AgentClient.send`.

//go:generate go run ./gen

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// The contract itself, mirrored into this package by `go generate` and compiled
// into the binary.
//
// WHY A MIRROR AND NOT A RELATIVE PATH: the agent runs on someone else's
// machine, where packages/protocol does not exist. The copy is generated, never
// edited, and SchemaSHA256 (schema_hash.go) pins the bytes it was made from — so
// editing zod without re-running `go generate ./...` fails a Go test instead of
// shipping a stale contract. The conformance corpus is the opposite case: it is
// test-only data, so tests read it by relative path rather than duplicating it.
//
//go:embed schema/protocol.schema.json
var schemaJSON []byte

// SchemaJSON returns the embedded contract. The bytes back the compiled
// validator, so callers must treat them as read-only.
func SchemaJSON() []byte { return schemaJSON }

// ErrInvalidFrame marks every rejection that came from the contract rather than
// from the transport. Callers use it to decide "drop and log" versus "the socket
// is broken".
var ErrInvalidFrame = errors.New("invalid frame")

// schemaID is an opaque base URI. The document has no `$id` of its own, and every
// reference inside it is a plain JSON pointer, so this only has to be stable.
const schemaID = "https://pdmux.dev/schema/protocol.schema.json"

type compiledSchemas struct {
	upstream   *jsonschema.Schema
	downstream *jsonschema.Schema
}

// Compiling the schema costs milliseconds and the result is immutable, so it
// happens once per process — but lazily, so importing this package never pays
// for a validator the program will not use.
var schemas = sync.OnceValues(compileSchemas)

func compileSchemas() (*compiledSchemas, error) {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(SchemaJSON()))
	if err != nil {
		return nil, fmt.Errorf("embedded schema is not valid JSON: %w", err)
	}
	compiler := jsonschema.NewCompiler()
	// ⚠ WITHOUT THIS, `format` IS A COMMENT. Five fields are `format: uuid`
	// (hostId, two commandIds, two service ids) and they are joins: a host id
	// that is not a uuid keys everything the agent stores to a string the server
	// cannot match back. Draft-07 asserts formats by default, but that default is
	// a property of the draft, not of our intent — saying it here keeps the check
	// if the contract is ever regenerated against a newer draft.
	compiler.AssertFormat()
	if err := compiler.AddResource(schemaID, doc); err != nil {
		return nil, fmt.Errorf("embedded schema could not be registered: %w", err)
	}
	upstream, err := compiler.Compile(schemaID + "#/$defs/agentUpstream")
	if err != nil {
		return nil, fmt.Errorf("compiling agentUpstream: %w", err)
	}
	downstream, err := compiler.Compile(schemaID + "#/$defs/agentDownstream")
	if err != nil {
		return nil, fmt.Errorf("compiling agentDownstream: %w", err)
	}
	return &compiledSchemas{upstream: upstream, downstream: downstream}, nil
}

// validate runs one frame through one compiled root.
//
// The instance is re-parsed with the schema library's own reader rather than
// reused from encoding/json: it keeps numbers as json.Number, which is what lets
// `type: integer` and a 2^53-scale timestamp both mean what they say.
func validate(schema *jsonschema.Schema, raw []byte) error {
	instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("%w: not JSON: %w", ErrInvalidFrame, err)
	}
	if err := schema.Validate(instance); err != nil {
		return fmt.Errorf("%w: %w", ErrInvalidFrame, err)
	}
	return nil
}

// ValidateUpstream reports whether raw is a legal agent -> server frame.
func ValidateUpstream(raw []byte) error {
	compiled, err := schemas()
	if err != nil {
		return err
	}
	return validate(compiled.upstream, raw)
}

// ValidateDownstream reports whether raw is a legal server -> agent frame.
func ValidateDownstream(raw []byte) error {
	compiled, err := schemas()
	if err != nil {
		return err
	}
	return validate(compiled.downstream, raw)
}

// DecodeUpstream validates raw and returns the branch it names.
//
// This is the server-side (and test-side) reader. An error is always a reason to
// drop the frame and read the next one — never to tear down the connection.
func DecodeUpstream(raw []byte) (UpstreamFrame, error) {
	if err := ValidateUpstream(raw); err != nil {
		return nil, err
	}
	frame, err := decodeUpstream(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidFrame, err)
	}
	return frame, nil
}

// DecodeDownstream validates raw and returns the branch it names.
//
// This is the agent's inbound path. An unknown `type` lands here as an error
// because the schema matched no branch; the caller logs it and keeps the socket,
// since telling a broken agent to update itself is the one thing that must
// always work.
func DecodeDownstream(raw []byte) (DownstreamFrame, error) {
	if err := ValidateDownstream(raw); err != nil {
		return nil, err
	}
	frame, err := decodeDownstream(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidFrame, err)
	}
	return frame, nil
}

// EncodeUpstream marshals an agent -> server frame, checking it against the
// contract first — except for terminal frames, which are exempt (see the file
// header).
//
// It stamps the frame's discriminator as a side effect, so a value built as a
// plain struct literal cannot go out with an empty `type`.
func EncodeUpstream(frame UpstreamFrame) ([]byte, error) {
	if frame == nil {
		return nil, fmt.Errorf("%w: nil upstream frame", ErrInvalidFrame)
	}
	kind := frame.stampUpstream()
	raw, err := json.Marshal(frame)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidFrame, err)
	}
	if kind == UpstreamTerminal {
		return raw, nil
	}
	if err := ValidateUpstream(raw); err != nil {
		return nil, err
	}
	return raw, nil
}

// EncodeDownstream marshals a server -> agent frame under the same rules as
// EncodeUpstream. The agent itself never sends one; a stub server and the
// conformance tests do.
func EncodeDownstream(frame DownstreamFrame) ([]byte, error) {
	if frame == nil {
		return nil, fmt.Errorf("%w: nil downstream frame", ErrInvalidFrame)
	}
	kind := frame.stampDownstream()
	raw, err := json.Marshal(frame)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidFrame, err)
	}
	if kind == DownstreamTerminal {
		return raw, nil
	}
	if err := ValidateDownstream(raw); err != nil {
		return nil, err
	}
	return raw, nil
}

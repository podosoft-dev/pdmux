package protocol

// Does the generated seeder really produce what zod produces?
//
// The interesting failures are not "a default is wrong" — they are "a default is
// INVISIBLE". `.default({})` on an object serialises as a literal `{}` with the
// nested values nowhere in the document, and a `default` sitting next to a `$ref`
// is a keyword a JSON-Schema validator is REQUIRED to ignore. So neither the
// schema nor the validator can tell you that `agentHello.update` should arrive as
// `{canRestart: false, restartMode: "none"}`. Only resolving it by type does.
//
// These tests therefore re-derive the expected defaults from the schema
// themselves — recursively, and without reusing a line of the generator — and
// compare against what the package actually produces. The registry below is
// written out by hand for the same reason: if it were derived, a new `$def` would
// be missing from both sides at once and the test would pass.

import (
	"encoding/json"
	"reflect"
	"testing"
)

// objectUnderTest gives the two ways a value of a contract type comes into
// existence: decoded from a frame that omitted every optional key, and built in
// Go through the generated constructor. Both must land on the same value —
// otherwise the agent normalises its own frames differently from the ones it
// reads.
type objectUnderTest struct {
	zero   func() any // pointer to a zero value, to unmarshal `{}` into
	seeded func() any // the NewXxx constructor
}

var objectDefs = map[string]objectUnderTest{
	"agentConfig":        {func() any { return new(AgentConfig) }, func() any { v := NewAgentConfig(); return &v }},
	"agentDiagnostic":    {func() any { return new(AgentDiagnostic) }, func() any { v := NewAgentDiagnostic(); return &v }},
	"agentHello":         {func() any { return new(AgentHello) }, func() any { v := NewAgentHello(); return &v }},
	"agentServiceConfig": {func() any { return new(AgentServiceConfig) }, func() any { v := NewAgentServiceConfig(); return &v }},
	"agentExec":          {func() any { return new(AgentExec) }, func() any { v := NewAgentExec(); return &v }},
	"agentUpdate":        {func() any { return new(AgentUpdate) }, func() any { v := NewAgentUpdate(); return &v }},
	"agentUpdateAbility": {func() any { return new(AgentUpdateAbility) }, func() any { v := NewAgentUpdateAbility(); return &v }},
	"agentUsage":         {func() any { return new(AgentUsage) }, func() any { v := NewAgentUsage(); return &v }},
	"commitDetail":       {func() any { return new(CommitDetail) }, func() any { v := NewCommitDetail(); return &v }},
	"diffFile":           {func() any { return new(DiffFile) }, func() any { v := NewDiffFile(); return &v }},
	"gitCommit":          {func() any { return new(GitCommit) }, func() any { v := NewGitCommit(); return &v }},
	"gitHead":            {func() any { return new(GitHead) }, func() any { v := NewGitHead(); return &v }},
	"gitRef":             {func() any { return new(GitRef) }, func() any { v := NewGitRef(); return &v }},
	"gitRemoteCheck":     {func() any { return new(GitRemoteCheck) }, func() any { v := NewGitRemoteCheck(); return &v }},
	"gitRemoteRef":       {func() any { return new(GitRemoteRef) }, func() any { v := NewGitRemoteRef(); return &v }},
	"gitBlob":            {func() any { return new(GitBlob) }, func() any { v := NewGitBlob(); return &v }},
	"gitTree":            {func() any { return new(GitTree) }, func() any { v := NewGitTree(); return &v }},
	"gitTreeEntry":       {func() any { return new(GitTreeEntry) }, func() any { v := NewGitTreeEntry(); return &v }},
	"fsDir":              {func() any { return new(FsDir) }, func() any { v := NewFsDir(); return &v }},
	"fsEntry":            {func() any { return new(FsEntry) }, func() any { v := NewFsEntry(); return &v }},
	"fsFile":             {func() any { return new(FsFile) }, func() any { v := NewFsFile(); return &v }},
	"fsChunk":            {func() any { return new(FsChunk) }, func() any { v := NewFsChunk(); return &v }},
	"fsWrote":            {func() any { return new(FsWrote) }, func() any { v := NewFsWrote(); return &v }},
	"fsRemoved":          {func() any { return new(FsRemoved) }, func() any { v := NewFsRemoved(); return &v }},
	"gitStatusFile":      {func() any { return new(GitStatusFile) }, func() any { v := NewGitStatusFile(); return &v }},
	"gitUncommitted":     {func() any { return new(GitUncommitted) }, func() any { v := NewGitUncommitted(); return &v }},
	"heartbeat":          {func() any { return new(Heartbeat) }, func() any { v := NewHeartbeat(); return &v }},
	"listener":           {func() any { return new(Listener) }, func() any { v := NewListener(); return &v }},
	"muxSession":         {func() any { return new(MuxSession) }, func() any { v := NewMuxSession(); return &v }},
	"repoSnapshot":       {func() any { return new(RepoSnapshot) }, func() any { v := NewRepoSnapshot(); return &v }},
	"resource":           {func() any { return new(Resource) }, func() any { v := NewResource(); return &v }},
	"serviceProbe":       {func() any { return new(ServiceProbe) }, func() any { v := NewServiceProbe(); return &v }},
	"terminalTarget":     {func() any { return new(TerminalTarget) }, func() any { v := NewTerminalTarget(); return &v }},
	"execResult":         {func() any { return new(ExecResult) }, func() any { v := NewExecResult(); return &v }},
	"updateStatus":       {func() any { return new(UpdateStatus) }, func() any { v := NewUpdateStatus(); return &v }},
	"usageWindow":        {func() any { return new(UsageWindow) }, func() any { v := NewUsageWindow(); return &v }},
	"workingDiff":        {func() any { return new(WorkingDiff) }, func() any { v := NewWorkingDiff(); return &v }},
}

func TestGeneratedDefaults(t *testing.T) {
	defs := schemaDefs(t)

	t.Run("[TC-PDAGENT-047] the registry covers exactly the object types in the contract", func(t *testing.T) {
		// Without this the whole file is only as complete as somebody's memory: a
		// new zod object would simply never be exercised.
		for name, def := range defs {
			if def["type"] != "object" {
				continue
			}
			if _, ok := objectDefs[name]; !ok {
				t.Errorf("$defs/%s is an object in the contract but is not tested here", name)
			}
		}
		for name := range objectDefs {
			if _, ok := defs[name]; !ok {
				t.Errorf("%s is tested here but is no longer in the contract", name)
			}
		}
	})

	t.Run("[TC-PDAGENT-047] decoding a frame that omits every optional key applies every default", func(t *testing.T) {
		for name, subject := range objectDefs {
			want := expectedDefaults(t, defs, defs[name])
			value := subject.zero()
			if err := json.Unmarshal([]byte(`{}`), value); err != nil {
				t.Fatalf("%s: unmarshalling an empty object: %v", name, err)
			}
			assertDefaults(t, name+" (decoded from {})", want, value)
		}
	})

	t.Run("[TC-PDAGENT-047] the generated constructor produces the same value as decoding", func(t *testing.T) {
		// A frame the agent BUILDS has to normalise like a frame it READS: this is
		// the direction where a nil slice turns into `null` and the server drops
		// the whole frame.
		for name, subject := range objectDefs {
			want := expectedDefaults(t, defs, defs[name])
			assertDefaults(t, name+" (from its constructor)", want, subject.seeded())
		}
	})

	t.Run("[TC-PDAGENT-047] a nested object default resolves to that type's defaults, not to {}", func(t *testing.T) {
		// The trap this whole generator exists for. The schema literally says
		// `"default": {}`, so a seeder that copies the JSON value leaves
		// restartMode at Go's zero "" — which is not a legal value of the enum and
		// is not what the server stores for every agent built before remote update.
		frame, err := DecodeUpstream([]byte(`{
			"type": "hello",
			"hello": {
				"protocolVersion": 1, "agentVersion": "0.1.0",
				"hostname": "h", "os": "linux", "arch": "amd64"
			}
		}`))
		if err != nil {
			t.Fatalf("decoding a hello without `update`: %v", err)
		}
		hello, ok := frame.(*HelloFrame)
		if !ok {
			t.Fatalf("decoded %T, want *HelloFrame", frame)
		}
		if hello.Hello.Update.RestartMode != RestartNone {
			t.Errorf("update.restartMode = %q, want %q", hello.Hello.Update.RestartMode, RestartNone)
		}
		if hello.Hello.Update.CanRestart {
			t.Error("update.canRestart = true, want false: an agent that never announced the ability cannot be restarted")
		}
		if hello.Hello.Capabilities == nil {
			t.Error("capabilities is nil, so it would marshal as null and the host would never register")
		}
	})

	t.Run("[TC-PDAGENT-047] defaults reach elements nested inside slices", func(t *testing.T) {
		// A top-level pre-seed cannot do this: the elements do not exist until the
		// decoder creates them. `x`/`y` default to a SPACE, and " M" (unstaged
		// modification) is a different fact from "M ".
		frame, err := DecodeUpstream([]byte(`{
			"type": "repos", "ts": 1784000000,
			"repos": [{
				"path": "/srv/pdmux", "name": "pdmux", "ts": 1784000000,
				"uncommitted": { "files": [ { "path": "a.ts", "y": "M" } ] }
			}]
		}`))
		if err != nil {
			t.Fatalf("decoding: %v", err)
		}
		repos, ok := frame.(*ReposFrame)
		if !ok {
			t.Fatalf("decoded %T, want *ReposFrame", frame)
		}
		snapshot := repos.Repos[0]
		file := snapshot.Uncommitted.Files[0]
		if file.X != " " || file.Y != "M" {
			t.Errorf("status letters = %q/%q, want %q/%q", file.X, file.Y, " ", "M")
		}
		// The snapshot is itself a slice element, so its own non-zero and slice
		// defaults are the same question one level up.
		if snapshot.Limit != 300 {
			t.Errorf("limit = %d, want 300: a repo the agent has only just found falls back to the contract's window", snapshot.Limit)
		}
		if snapshot.Commits == nil || snapshot.Refs == nil || snapshot.Details == nil {
			t.Error("a slice default inside a slice element is nil, so it would marshal as null")
		}
	})

	t.Run("[TC-PDAGENT-047] a key the contract leaves absent stays absent", func(t *testing.T) {
		// The mirror image of every other case here: `label` and `session` have no
		// default at all, so zod leaves the KEY MISSING. Sending "" instead is a
		// different normalised frame.
		window := NewUsageWindow()
		window.Key = "session"
		encoded, err := json.Marshal(window)
		if err != nil {
			t.Fatal(err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		if _, present := decoded["label"]; present {
			t.Errorf("usageWindow carries a `label` key it was never given: %s", encoded)
		}
		if _, present := decoded["usedPct"]; !present {
			t.Errorf("usageWindow dropped `usedPct`, which defaults to null and must travel: %s", encoded)
		}
	})
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func schemaDefs(t *testing.T) map[string]map[string]any {
	t.Helper()
	var document struct {
		Defs map[string]map[string]any `json:"$defs"`
	}
	if err := json.Unmarshal(SchemaJSON(), &document); err != nil {
		t.Fatalf("reading the embedded contract: %v", err)
	}
	if len(document.Defs) == 0 {
		t.Fatal("the embedded contract has no $defs")
	}
	return document.Defs
}

// expectedDefaults derives, straight from the schema, the value every defaulted
// property must hold when the key is absent — resolving an object default to the
// referenced type's own defaults rather than to the `{}` the document shows.
func expectedDefaults(t *testing.T, defs map[string]map[string]any, def map[string]any) map[string]any {
	t.Helper()
	out := map[string]any{}
	properties, _ := def["properties"].(map[string]any)
	for name, raw := range properties {
		property, _ := raw.(map[string]any)
		value, ok := property["default"]
		if !ok {
			continue
		}
		if object, isObject := value.(map[string]any); isObject && len(object) == 0 {
			ref, isRef := property["$ref"].(string)
			if !isRef {
				t.Fatalf("property %s defaults to {} but references nothing", name)
			}
			out[name] = expectedDefaults(t, defs, defs[refName(t, ref)])
			continue
		}
		out[name] = value
	}
	return out
}

func refName(t *testing.T, ref string) string {
	t.Helper()
	const prefix = "#/$defs/"
	if len(ref) <= len(prefix) || ref[:len(prefix)] != prefix {
		t.Fatalf("unexpected $ref %q", ref)
	}
	return ref[len(prefix):]
}

// assertDefaults compares the defaulted keys of a marshalled value against the
// schema. Comparing after a round trip through JSON is deliberate: it is the wire
// bytes the two languages have to agree on, not the Go representation.
func assertDefaults(t *testing.T, what string, want map[string]any, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("%s: %v", what, err)
	}
	var got map[string]any
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("%s: %v", what, err)
	}
	for key, expected := range want {
		actual, present := got[key]
		if !present {
			t.Errorf("%s: %s is missing; the contract defaults it to %s", what, key, mustJSON(expected))
			continue
		}
		if !reflect.DeepEqual(actual, expected) {
			t.Errorf("%s: %s = %s, want %s", what, key, mustJSON(actual), mustJSON(expected))
		}
	}
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "<unencodable>"
	}
	return string(encoded)
}

package semver

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
)

// The table is READ, never copied. Hand-transcribing the rows into Go would make this
// suite prove that the transcriber agreed with themselves; both languages opening the
// same bytes is the entire point.
const tablePath = "../../../packages/protocol/conformance/semver.json"

// The floor is a constant a schema cannot express, so the protocol package publishes it
// as a generated artefact. Checking ours against it costs one file read and closes the
// one drift this package cannot otherwise notice.
const constantsPath = "../../../packages/protocol/schema/constants.json"

type parseRow struct {
	ID    string `json:"id"`
	Input string `json:"input"`
	// Expect is nil for the rows that must not parse. Unmarshalling into the real
	// Semver (not a local copy of it) is deliberate: it also pins the JSON field names,
	// and a `prerelease: []` in the table lands here as an empty non-nil slice, so
	// DeepEqual below fails if Parse ever starts returning nil.
	Expect *Semver `json:"expect"`
	Why    string  `json:"why"`
}

type compareRow struct {
	ID string `json:"id"`
	A  string `json:"a"`
	B  string `json:"b"`
	// Expect is nil where no ordering exists (something did not parse).
	Expect *int   `json:"expect"`
	Why    string `json:"why"`
}

type conformanceTable struct {
	Description string       `json:"description"`
	Parse       []parseRow   `json:"parse"`
	Compare     []compareRow `json:"compare"`
}

// loadTable reads the shared table, and fails loudly if it cannot.
//
// Skipping when the file is missing would be the worst outcome available: the suite
// goes green while asserting nothing, which is precisely the silent disagreement the
// table exists to catch. A test that passes on an empty table is worse than no test.
func loadTable(t *testing.T) conformanceTable {
	t.Helper()
	raw, err := os.ReadFile(tablePath)
	if err != nil {
		t.Fatalf("read the shared conformance table %s: %v", tablePath, err)
	}
	var table conformanceTable
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatalf("parse %s: %v", tablePath, err)
	}
	if len(table.Parse) == 0 || len(table.Compare) == 0 {
		t.Fatalf("%s has %d parse and %d compare rows; an empty table asserts nothing",
			tablePath, len(table.Parse), len(table.Compare))
	}
	return table
}

func TestSemverConformance(t *testing.T) {
	table := loadTable(t)

	t.Run("[TC-PDAGENT-070] the shared table was really read", func(t *testing.T) {
		// The count goes in the log so `go test -v` shows how much was exercised —
		// otherwise "PASS" looks the same whether 31 rows ran or none did.
		t.Logf("read %s: %d parse rows, %d compare rows", tablePath, len(table.Parse), len(table.Compare))
		for _, row := range table.Parse {
			if row.Why == "" {
				t.Errorf("parse row %q has no `why`; a row nobody can defend is a row that gets deleted", row.ID)
			}
		}
		for _, row := range table.Compare {
			if row.Why == "" {
				t.Errorf("compare row %q has no `why`", row.ID)
			}
		}
	})

	for _, row := range table.Parse {
		t.Run(fmt.Sprintf("[TC-PDAGENT-070] parse %s (%q)", row.ID, row.Input), func(t *testing.T) {
			got, ok := Parse(row.Input)
			if row.Expect == nil {
				if ok {
					t.Fatalf("Parse(%q) = %+v, want no parse — %s", row.Input, got, row.Why)
				}
				return
			}
			if !ok {
				t.Fatalf("Parse(%q) did not parse, want %+v — %s", row.Input, *row.Expect, row.Why)
			}
			if !reflect.DeepEqual(got, *row.Expect) {
				t.Fatalf("Parse(%q) = %+v, want %+v — %s", row.Input, got, *row.Expect, row.Why)
			}
		})
	}

	for _, row := range table.Compare {
		t.Run(fmt.Sprintf("[TC-PDAGENT-070] compare %s (%s vs %s)", row.ID, row.A, row.B), func(t *testing.T) {
			got, ok := CompareStrings(row.A, row.B)
			assertVerdict(t, got, ok, row.Expect, fmt.Sprintf("CompareStrings(%q, %q)", row.A, row.B), row.Why)

			// Antisymmetry, for free: every row is also its own mirror, so no row can be
			// satisfied by a comparator that got the sign right in only one direction.
			back, backOK := CompareStrings(row.B, row.A)
			assertVerdict(t, back, backOK, mirrorOf(row.Expect), fmt.Sprintf("CompareStrings(%q, %q)", row.B, row.A), row.Why)

			// Compare is what the agent calls when it refuses a downgrade; the string
			// wrapper is a convenience, and both must agree on every row.
			left, leftOK := Parse(row.A)
			right, rightOK := Parse(row.B)
			if !leftOK || !rightOK {
				if row.Expect != nil {
					t.Fatalf("row expects a verdict but %q/%q did not both parse", row.A, row.B)
				}
				return
			}
			if verdict := Compare(left, right); row.Expect == nil || verdict != *row.Expect {
				t.Fatalf("Compare(%+v, %+v) = %d, want %v — %s", left, right, verdict, deref(row.Expect), row.Why)
			}
		})
	}

	t.Run("[TC-PDAGENT-070] the table still covers the edges people get wrong", func(t *testing.T) {
		// Guards against the table being quietly trimmed to the easy rows. Each of these
		// is a real divergence between a spec-correct comparator and a plausible one, so
		// losing the row would let a wrong port pass.
		parseIDs := map[string]bool{}
		for _, row := range table.Parse {
			parseIDs[row.ID] = true
		}
		for _, id := range []string{
			"invalid-leading-zero-core",
			"invalid-numeric-leading-zero-prerelease",
			"prerelease-alphanumeric-leading-zero",
			"invalid-v-prefix",
			"prerelease-and-build",
		} {
			if !parseIDs[id] {
				t.Errorf("parse row %q is gone from the shared table", id)
			}
		}
		compareIDs := map[string]bool{}
		for _, row := range table.Compare {
			compareIDs[row.ID] = true
		}
		for _, id := range []string{
			"prerelease-below-release",
			"build-metadata-ignored",
			"patch-numeric-not-lexical",
			"numeric-identifier-below-alphanumeric",
			"fewer-identifiers-first",
		} {
			if !compareIDs[id] {
				t.Errorf("compare row %q is gone from the shared table", id)
			}
		}
	})

	t.Run("[TC-PDAGENT-070] the support floor matches the published constant", func(t *testing.T) {
		// MIN_SUPPORTED_AGENT decides who gets the hard `incompatible` badge. It lives in
		// TypeScript and is duplicated here as a const, so the only thing standing between
		// a bump on one side and a fleet judged by two different floors is this check.
		raw, err := os.ReadFile(constantsPath)
		if err != nil {
			t.Fatalf("read the generated constants %s: %v", constantsPath, err)
		}
		var constants struct {
			MinSupportedAgent string `json:"MIN_SUPPORTED_AGENT"`
		}
		if err := json.Unmarshal(raw, &constants); err != nil {
			t.Fatalf("parse %s: %v", constantsPath, err)
		}
		if constants.MinSupportedAgent != MinSupportedAgent {
			t.Fatalf("MinSupportedAgent = %q, but the protocol publishes %q", MinSupportedAgent, constants.MinSupportedAgent)
		}
		if _, ok := Parse(MinSupportedAgent); !ok {
			t.Fatalf("MinSupportedAgent %q does not parse, so the floor check silently never fires", MinSupportedAgent)
		}
	})
}

// assertVerdict compares a (verdict, ok) pair against the table's nullable expectation.
func assertVerdict(t *testing.T, got int, ok bool, want *int, call string, why string) {
	t.Helper()
	if want == nil {
		if ok {
			t.Fatalf("%s = %d, want no ordering — %s", call, got, why)
		}
		return
	}
	if !ok {
		t.Fatalf("%s reported no ordering, want %d — %s", call, *want, why)
	}
	if got != *want {
		t.Fatalf("%s = %d, want %d — %s", call, got, *want, why)
	}
}

// mirrorOf is the verdict the reversed comparison must return. Written out rather than
// negated so that "no ordering" mirrors to "no ordering" instead of to 0.
func mirrorOf(want *int) *int {
	if want == nil {
		return nil
	}
	flipped := -*want
	return &flipped
}

func deref(v *int) any {
	if v == nil {
		return "no ordering"
	}
	return *v
}

func TestAgentVersionState(t *testing.T) {
	const supported = 1
	matching := supported
	stale := supported + 1

	cases := []struct {
		name  string
		input VersionInput
		want  State
		why   string
	}{
		{
			name:  "current",
			input: VersionInput{AgentVersion: "1.2.3", ProtocolVersion: &matching, Latest: "1.2.3", ProtocolVersionSupported: supported},
			want:  StateCurrent,
			why:   "`current` is the absence of a difference, not a small one — equality has to land exactly here",
		},
		{
			name:  "outdated",
			input: VersionInput{AgentVersion: "1.2.3", ProtocolVersion: &matching, Latest: "1.3.0", ProtocolVersionSupported: supported},
			want:  StateOutdated,
			why:   "the state the Update button is drawn from; if Go and the API disagree here the button is offered and then refused",
		},
		{
			name:  "outdated for a dev build of the published release",
			input: VersionInput{AgentVersion: "0.2.0-dev.3+g1a2b3c", ProtocolVersion: &matching, Latest: "0.2.0", ProtocolVersionSupported: supported},
			want:  StateOutdated,
			why:   "a prerelease is below the release it leads to, which is what decides whether a developer machine shows an update",
		},
		{
			name:  "a working-tree build of the floor version is merely outdated",
			input: VersionInput{AgentVersion: "0.1.0-dev.3+g1a2b3c", ProtocolVersion: &matching, Latest: "0.1.0", ProtocolVersionSupported: supported},
			want:  StateOutdated,
			why: "this is the case the `-0` in MinSupportedAgent exists for. A prerelease sorts below its release, so a " +
				"floor of plain `0.1.0` would put every build compiled from a checkout below the floor and paint every " +
				"developer's own machine `incompatible` for the whole of 0.1.0's development. `0.1.0-0` is the lowest " +
				"prerelease of that version, so such a build is admitted — and still correctly reported as behind `0.1.0`. " +
				"⚠ If this ever flips back to incompatible, the fix belongs in the floor value, never in a second comparator",
		},
		{
			name:  "ahead",
			input: VersionInput{AgentVersion: "1.4.0", ProtocolVersion: &matching, Latest: "1.3.0", ProtocolVersionSupported: supported},
			want:  StateAhead,
			why:   "a host running newer than what is published is not outdated, and must never be offered a downgrade",
		},
		{
			name:  "unknown when the version string is unreadable",
			input: VersionInput{AgentVersion: "banana", ProtocolVersion: &matching, Latest: "1.3.0", ProtocolVersionSupported: supported},
			want:  StateUnknown,
			why:   "an unreadable version reads as unknown, never as 0.0.0 — which would mark the host outdated forever",
		},
		{
			name:  "unknown when nothing is published for the platform",
			input: VersionInput{AgentVersion: "1.2.3", ProtocolVersion: &matching, Latest: "", ProtocolVersionSupported: supported},
			want:  StateUnknown,
			why:   "the second unknown shares the first one's badge on purpose: both mean we cannot say this host is behind",
		},
		{
			name:  "incompatible when the wire contract differs",
			input: VersionInput{AgentVersion: "1.2.3", ProtocolVersion: &stale, Latest: "1.2.3", ProtocolVersionSupported: supported},
			want:  StateIncompatible,
			why:   "the hard statement: the frames themselves differ, so being on the newest build does not help",
		},
		{
			name:  "incompatible when the build predates the floor",
			input: VersionInput{AgentVersion: "0.0.9", ProtocolVersion: &matching, Latest: "1.2.3", ProtocolVersionSupported: supported},
			want:  StateIncompatible,
			why:   "below MinSupportedAgent the server no longer keeps features on, which outranks merely being outdated",
		},
		{
			name:  "incompatible outranks unknown",
			input: VersionInput{AgentVersion: "banana", ProtocolVersion: &stale, Latest: "1.2.3", ProtocolVersionSupported: supported},
			want:  StateIncompatible,
			why:   "the protocol check runs before the parse verdict; saying `unknown` here would hide the one fact a reader can act on",
		},
		{
			name:  "the floor itself is supported",
			input: VersionInput{AgentVersion: MinSupportedAgent, ProtocolVersion: &matching, Latest: MinSupportedAgent, ProtocolVersionSupported: supported},
			want:  StateCurrent,
			why:   "the comparison is `< floor`, not `<= floor` — an off-by-one here condemns the oldest supported fleet",
		},
		{
			name:  "a host that has never connected is judged on its version alone",
			input: VersionInput{AgentVersion: "1.2.3", ProtocolVersion: nil, Latest: "1.3.0", ProtocolVersionSupported: supported},
			want:  StateOutdated,
			why:   "nil protocolVersion means no hello was ever seen; treating it as 0 would call every new host incompatible",
		},
	}

	for _, testCase := range cases {
		t.Run("[TC-PDAGENT-070] "+testCase.name, func(t *testing.T) {
			if got := AgentVersionState(testCase.input); got != testCase.want {
				t.Fatalf("AgentVersionState(%+v) = %q, want %q — %s", testCase.input, got, testCase.want, testCase.why)
			}
		})
	}
}

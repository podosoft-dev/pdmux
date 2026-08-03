// Package semver mirrors packages/protocol/src/semver.ts — not in spirit, in
// behaviour.
//
// WHY A HAND-WRITTEN COPY AND NOT A LIBRARY: three programs decide whether a host is
// outdated — the API (TypeScript), the browser (TypeScript) and this agent. If the
// comparator disagrees between them the dashboard offers an Update button that the
// agent then refuses, which reads as a broken product rather than as the disagreement
// it is. So the goal is not "correct SemVer", it is "identical to the TypeScript", and
// matching another Go library's edge-case choices against the zod side is harder than
// owning eighty lines.
//
// The proof is data, not trust: packages/protocol/conformance/semver.json holds the
// table, both languages read that one file, and semver_test.go asserts every row.
//
// WHAT IS DELIBERATELY MISSING: ranges, carets, tildes, coercion. Nothing here needs
// "^1.2" — it needs "is this one older than that one", and every extra feature is
// another thing two implementations can disagree about.
package semver

import (
	"strconv"
	"strings"
)

// MinSupportedAgent is the lowest agent version this server understands well enough to
// keep features on. It mirrors MIN_SUPPORTED_AGENT in the protocol package, which is
// also published as a generated artefact (packages/protocol/schema/constants.json) —
// the test asserts the two against each other, because a floor that drifts silently
// hands out `incompatible`, and `incompatible` is a hard statement.
const MinSupportedAgent = "0.1.0-0"

// A version string longer than this is not a version. The cap exists so a hostile or
// merely broken agent cannot make the parser walk an arbitrarily long string.
const maxVersionLength = 256

// Semver is a parsed version.
//
// The JSON names match the TypeScript interface and the shared conformance table, so
// the table unmarshals straight into this type: renaming a field here then fails the
// test instead of quietly comparing something else.
type Semver struct {
	Major int `json:"major"`
	Minor int `json:"minor"`
	Patch int `json:"patch"`
	// Prerelease holds the dot-separated identifiers, empty for a release:
	// `1.0.0-rc.1` → ["rc","1"]. Parse returns a non-nil empty slice rather than nil,
	// because a nil slice marshals to `null` and the contract says an empty
	// prerelease is `[]` — the conformance corpus exists largely to catch that
	// distinction.
	Prerelease []string `json:"prerelease"`
	// Build is carried so a caller can display it. It is NEVER part of an ordering
	// (SemVer §10).
	Build []string `json:"build"`
}

// isDigits reports whether s is one or more ASCII digits.
//
// The checks below are hand-rolled rather than regexps on purpose: the whole point of
// this file is that two implementations cannot disagree, and a literal loop over ASCII
// has no flags, no locale and no engine differences to get wrong.
func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// isNumeric reports whether s is a SemVer numeric identifier: digits with no leading
// zero. `01` is not a SemVer number — accepting it invites two readings of the same
// version, and a lenient parser on one side of the wire is a silent disagreement.
func isNumeric(s string) bool {
	if !isDigits(s) {
		return false
	}
	return s == "0" || s[0] != '0'
}

// isIdentifier reports whether s matches `[0-9A-Za-z-]+`. Iterating bytes is enough:
// every byte of a multi-byte character is ≥ 0x80 and falls through to false.
func isIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
		case c >= 'A' && c <= 'Z':
		case c >= 'a' && c <= 'z':
		case c == '-':
		default:
			return false
		}
	}
	return true
}

// Parse reads a version, reporting whether it was one.
//
// It never panics and carries no error value: the input is a string an agent sent us,
// and a host with a weird version string must still appear in the UI — that is exactly
// the host somebody needs to update.
func Parse(value string) (Semver, bool) {
	// TypeScript caps the same input in UTF-16 units and this caps bytes. The two can
	// only differ for a non-ASCII string, and every non-ASCII byte fails the identifier
	// check below, so both sides still reject it — just on a different line.
	if len(value) == 0 || len(value) > maxVersionLength {
		return Semver{}, false
	}

	// Build metadata comes off FIRST: in `1.0.0-rc.1+g1a2b3c` the `+` sits after the
	// `-`, so stripping in the other order would swallow the build into the prerelease
	// and yield `rc.1+g1a2b3c` as one identifier.
	rest := value
	build := []string{}
	if plus := strings.IndexByte(rest, '+'); plus >= 0 {
		build = strings.Split(rest[plus+1:], ".")
		rest = rest[:plus]
		// Only the FIRST `+` separates; a second one is not a legal identifier
		// character, so `1.0.0+build+extra` fails here rather than parsing.
		for _, id := range build {
			if !isIdentifier(id) {
				return Semver{}, false
			}
		}
	}

	prerelease := []string{}
	if dash := strings.IndexByte(rest, '-'); dash >= 0 {
		prerelease = strings.Split(rest[dash+1:], ".")
		rest = rest[:dash]
		for _, id := range prerelease {
			if !isIdentifier(id) {
				return Semver{}, false
			}
			// A numeric identifier keeps the no-leading-zeros rule because it is
			// compared as a number and `01` would tie with `1`; an alphanumeric one
			// does not, so `0a` is a fine identifier.
			if isDigits(id) && !isNumeric(id) {
				return Semver{}, false
			}
		}
	}

	core := strings.Split(rest, ".")
	if len(core) != 3 {
		return Semver{}, false
	}
	numbers := [3]int{}
	for i, part := range core {
		if !isNumeric(part) {
			return Semver{}, false
		}
		n, err := strconv.Atoi(part)
		if err != nil {
			// Only reachable for a number too long for an int (20+ digits), where
			// TypeScript would take a lossy float instead. The corpus README leaves
			// that corner unspecified on purpose; refusing is the reading that cannot
			// silently tie two versions that differ.
			return Semver{}, false
		}
		numbers[i] = n
	}

	return Semver{
		Major:      numbers[0],
		Minor:      numbers[1],
		Patch:      numbers[2],
		Prerelease: prerelease,
		Build:      build,
	}, true
}

// compareIdentifiers orders two prerelease identifiers.
func compareIdentifiers(a, b string) int {
	aNum := isNumeric(a)
	bNum := isNumeric(b)
	// "Numeric identifiers always have lower precedence than alphanumeric" (SemVer §11).
	if aNum != bNum {
		if aNum {
			return -1
		}
		return 1
	}
	if aNum && len(a) != len(b) {
		// Both are digit strings with no leading zero, so the longer one is the larger
		// number and equal lengths compare correctly byte by byte below. Deciding it
		// this way rather than with strconv is exactly equal to comparing the numbers
		// for every value either language can hold, and has no overflow path at all —
		// TypeScript's Number() starts losing precision above 2^53.
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	// ASCII order, where every upper-case letter sorts before every lower-case one.
	// Over `[0-9A-Za-z-]` a JS string `<` and Go's byte compare agree exactly.
	return strings.Compare(a, b)
}

// Compare returns -1, 0 or 1.
//
// Build metadata is ignored, so `1.0.0+a` and `1.0.0+b` are the SAME version — which is
// why the update path pins a sha256 as well as a version.
func Compare(a, b Semver) int {
	for _, pair := range [3][2]int{
		{a.Major, b.Major},
		{a.Minor, b.Minor},
		{a.Patch, b.Patch},
	} {
		if pair[0] != pair[1] {
			if pair[0] < pair[1] {
				return -1
			}
			return 1
		}
	}

	// A prerelease is LOWER than the release it leads to: 1.0.0-rc.1 < 1.0.0.
	aPre := len(a.Prerelease) > 0
	bPre := len(b.Prerelease) > 0
	if aPre != bPre {
		if aPre {
			return -1
		}
		return 1
	}
	if !aPre {
		return 0
	}

	shared := min(len(a.Prerelease), len(b.Prerelease))
	for i := 0; i < shared; i++ {
		if verdict := compareIdentifiers(a.Prerelease[i], b.Prerelease[i]); verdict != 0 {
			return verdict
		}
	}
	// All shared identifiers equal — more identifiers wins (`1.0.0-a` < `1.0.0-a.1`).
	// This is the rule a port forgets once it has compared the shared prefix.
	if len(a.Prerelease) == len(b.Prerelease) {
		return 0
	}
	if len(a.Prerelease) < len(b.Prerelease) {
		return -1
	}
	return 1
}

// CompareStrings is the convenience for callers holding strings. The bool is false when
// either side did not parse: no ordering exists against something unreadable, and
// answering -1 or 0 there would either nag a host forever or call it current on no
// evidence.
func CompareStrings(a, b string) (int, bool) {
	left, ok := Parse(a)
	if !ok {
		return 0, false
	}
	right, ok := Parse(b)
	if !ok {
		return 0, false
	}
	return Compare(left, right), true
}

// State is how a host's agent version reads on a card.
//
// `incompatible` is a HARD statement (the wire contract differs, or the build predates
// what this server supports); everything else is advisory. Note what is NOT here: a
// state that refuses the connection. The one thing you must always be able to do to a
// too-old agent is tell it to update, and you cannot tell it anything if you hung up.
type State string

const (
	StateCurrent      State = "current"
	StateOutdated     State = "outdated"
	StateAhead        State = "ahead"
	StateUnknown      State = "unknown"
	StateIncompatible State = "incompatible"
)

// VersionInput is what AgentVersionState needs to reach a verdict.
type VersionInput struct {
	// AgentVersion is what the agent reported in `hello` — free-form on the wire, on
	// purpose. The TypeScript field is nullable; here the empty string carries that,
	// because "absent" and "unreadable" already reach the same state and a pointer
	// would only add a way to dereference nothing.
	AgentVersion string
	// ProtocolVersion is `hello.protocolVersion`, nil when the host has never
	// connected. This one IS a pointer: 0 is a version number a broken agent could
	// genuinely send, so a sentinel would turn "never connected" into "incompatible".
	ProtocolVersion *int
	// Latest is the newest published build FOR THAT HOST's os/arch; empty when nothing
	// is published for it.
	Latest string
	// ProtocolVersionSupported is PROTOCOL_VERSION, passed in so this package stays
	// free of frame imports.
	ProtocolVersionSupported int
}

// AgentVersionState reduces a host's reported version to the badge it earns.
//
// The order of the checks is the contract: incompatible outranks unknown, which
// outranks the three comparative states. A host whose protocol does not match is
// incompatible whether or not its version string parses, and saying "unknown" there
// would hide the one fact a reader can act on.
func AgentVersionState(input VersionInput) State {
	current, currentOK := Parse(input.AgentVersion)

	if input.ProtocolVersion != nil && *input.ProtocolVersion != input.ProtocolVersionSupported {
		return StateIncompatible
	}
	floor, floorOK := Parse(MinSupportedAgent)
	if currentOK && floorOK && Compare(current, floor) < 0 {
		return StateIncompatible
	}

	// Two different unknowns share one state on purpose: the agent's version is
	// unreadable, OR nothing is published for its platform. Both mean "we cannot say
	// this host is behind", and inventing a second badge for that would say nothing a
	// reader could act on differently.
	if !currentOK {
		return StateUnknown
	}
	latest, latestOK := Parse(input.Latest)
	if !latestOK {
		return StateUnknown
	}

	switch verdict := Compare(current, latest); {
	case verdict > 0:
		return StateAhead
	case verdict < 0:
		return StateOutdated
	default:
		return StateCurrent
	}
}

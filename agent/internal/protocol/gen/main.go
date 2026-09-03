// Command gen turns the generated contract artefacts into the Go sources this
// package embeds and depends on.
//
// WHY A GENERATOR AND NOT HAND-WRITTEN DEFAULTS: zod fills a default for every
// key that arrives as `undefined`, and there are 90-odd of them. Transcribing
// that by hand is not hard — it is hard to KEEP right, and being wrong is
// silent: an absent `heartbeatSec` read as 0 does not fail, it polls in a hot
// loop; an absent `restartMode` read as "" does not fail, it just stops matching
// the value the server stored. So the defaults are transcribed mechanically, and
// the transcription is checked against the Go structs at generation time.
//
// THREE TRAPS THIS FILE EXISTS TO AVOID, ALL OF THEM REAL:
//
//  1. `.default({})` ON AN OBJECT EMITS A LITERAL `{}` IN THE SCHEMA. The nested
//     defaults are INVISIBLE there — and worse, that `default` sits as a sibling
//     of `$ref`, which a JSON-Schema validator is required to ignore. Copying the
//     JSON default value would seed `agentHello.update` as a zero struct, whose
//     `restartMode` is "" where zod says "none". Defaults are therefore applied
//     RECURSIVELY BY TYPE (see refDefault below), never by copying the literal.
//     Three sites: heartbeat.resource, repoSnapshot.head, agentHello.update.
//
//  2. DEFAULTS MUST REACH SLICE ELEMENTS. `uncommitted.files[].x` defaults to a
//     SPACE, and no amount of top-level pre-seeding puts it there. The generated
//     UnmarshalJSON seeds the receiver and then unmarshals over it, so
//     encoding/json calls the same method for every element of every slice at
//     every depth — which reproduces "undefined -> default" exactly where zod
//     does it.
//
//  3. A NEW ZOD OBJECT MUST NOT SLIP THROUGH. Every `$def` is classified and
//     must map to something in Go; every property must have a field and every
//     field a property. A `$def` this program cannot place is a non-zero exit,
//     because the alternative is an agent that silently ignores a new field.
//
// The whole thing is a no-op to re-run: `go generate ./... && git diff
// --exit-code` is the check that the committed sources match the contract.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "protocol/gen: %v\n", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------------------
// What the schema's four kinds of `$def` map to
// ---------------------------------------------------------------------------

// unionBranches names the Go type behind each branch of each discriminated
// union. This is the one mapping that cannot be derived: the wire tag is
// "terminal" in both directions and the Go types have to differ.
//
// A branch missing from here fails generation, which is the point — adding a
// frame to the contract has to add one to the agent.
var unionBranches = map[string]map[string]string{
	"agentUpstream": {
		"hello":        "HelloFrame",
		"heartbeat":    "HeartbeatFrame",
		"repos":        "ReposFrame",
		"terminal":     "TerminalUpstream",
		"pong":         "PongFrame",
		"updateStatus": "UpdateStatusFrame",
		"execResult":   "ExecResultFrame",
		"fsDir":        "FsDirFrame",
		"fsFile":       "FsFileFrame",
		"fsChunk":      "FsChunkFrame",
		"fsWrote":      "FsWroteFrame",
		"fsRemoved":    "FsRemovedFrame",
	},
	"agentDownstream": {
		"welcome":      "WelcomeFrame",
		"config":       "ConfigFrame",
		"update":       "UpdateFrame",
		"terminal":     "TerminalDownstream",
		"ping":         "PingFrame",
		"collect":      "CollectFrame",
		"commitDetail": "CommitDetailFrame",
		"detailAck":    "DetailAckFrame",
		"fileTree":     "FileTreeFrame",
		"fileContent":  "FileContentFrame",
		"exec":         "ExecFrame",
		"fsList":       "FsListFrame",
		"fsRead":       "FsReadFrame",
		"fsGet":        "FsGetFrame",
		"fsPut":        "FsPutFrame",
		"fsDelete":     "FsDeleteFrame",
	},
	"terminalServerFrame": {
		"ready":  "TerminalReady",
		"output": "TerminalOutput",
		"exit":   "TerminalExit",
		"error":  "TerminalError",
	},
	"terminalClientFrame": {
		"open":   "TerminalOpen",
		"input":  "TerminalInput",
		"resize": "TerminalResize",
		"close":  "TerminalClose",
	},
}

// knownScalars are the `$def`s that are a bare number with bounds. They have no
// Go type of their own — they are inlined as int/int64 at each use — but they are
// listed so a NEW scalar def is noticed rather than ignored.
var knownScalars = map[string]bool{"percent": true, "epochSeconds": true}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

func run() error {
	schemaDir := flag.String("schema", filepath.Join("..", "..", "..", "packages", "protocol", "schema"),
		"directory holding the generated protocol.schema.json and constants.json")
	out := flag.String("out", ".", "the internal/protocol package directory to write into")
	flag.Parse()

	// Refuse to write anywhere that is not the package: `go generate` runs with
	// the package directory as its working directory, and a wrong -out would
	// scatter generated files into the tree.
	if _, err := os.Stat(filepath.Join(*out, "types.go")); err != nil {
		return fmt.Errorf("-out %q does not look like internal/protocol (no types.go): run this via `go generate ./internal/protocol`", *out)
	}

	schemaBytes, err := os.ReadFile(filepath.Join(*schemaDir, "protocol.schema.json"))
	if err != nil {
		return fmt.Errorf("reading the contract: %w", err)
	}
	constantsBytes, err := os.ReadFile(filepath.Join(*schemaDir, "constants.json"))
	if err != nil {
		return fmt.Errorf("reading the contract constants: %w", err)
	}

	schema, err := decodeJSON(schemaBytes)
	if err != nil {
		return fmt.Errorf("protocol.schema.json: %w", err)
	}
	constants, err := decodeJSON(constantsBytes)
	if err != nil {
		return fmt.Errorf("constants.json: %w", err)
	}

	pkg, err := parsePackage(*out)
	if err != nil {
		return err
	}

	defs, ok := schema["$defs"].(map[string]any)
	if !ok {
		return fmt.Errorf("protocol.schema.json has no $defs object")
	}

	objects, err := classify(defs, pkg)
	if err != nil {
		return err
	}

	defaults, err := renderDefaults(defs, objects, pkg)
	if err != nil {
		return err
	}
	consts, err := renderConstants(constants)
	if err != nil {
		return err
	}
	hashes := renderHashes(schemaBytes, constantsBytes)

	// The mirror is copied byte for byte, so SchemaSHA256 pins exactly what the
	// running agent validates against.
	if err := os.MkdirAll(filepath.Join(*out, "schema"), 0o755); err != nil {
		return err
	}
	files := []struct {
		path string
		data []byte
	}{
		{filepath.Join(*out, "schema", "protocol.schema.json"), schemaBytes},
		{filepath.Join(*out, "defaults_gen.go"), defaults},
		{filepath.Join(*out, "consts_gen.go"), consts},
		{filepath.Join(*out, "schema_hash.go"), hashes},
	}
	for _, file := range files {
		if err := writeIfChanged(file.path, file.data); err != nil {
			return err
		}
	}
	return nil
}

// writeIfChanged keeps the file's mtime stable when nothing moved, so a no-op
// `go generate` does not invalidate a build cache.
func writeIfChanged(path string, data []byte) error {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
		return nil
	}
	return os.WriteFile(path, data, 0o644)
}

func decodeJSON(data []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	// Keep numbers as text: a default of 262144 must be emitted as 262144, not as
	// 262144.0 or 2.62144e+05.
	dec.UseNumber()
	var out map[string]any
	if err := dec.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// The Go package, as parsed
// ---------------------------------------------------------------------------

type goField struct {
	Name      string // Go field name
	JSONName  string // the wire key
	Type      string // the declared type, as source text
	OmitEmpty bool
	Pointer   bool
	Slice     bool
	// Struct is true when Type names a struct declared in this package, which is
	// what makes `x.Field.applyDefaults()` legal.
	Struct bool
}

type goPackage struct {
	structs map[string][]goField // struct name -> fields, in declaration order
	named   map[string]bool      // every named type declared in the package
}

func parsePackage(dir string) (*goPackage, error) {
	fset := token.NewFileSet()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", dir, err)
	}

	pkg := &goPackage{structs: map[string][]goField{}, named: map[string]bool{}}
	structTypes := map[string]*ast.StructType{}
	for _, entry := range entries {
		name := entry.Name()
		// Generated files are parsed too (they declare no types, so they cannot
		// mislead) but tests are skipped: a test fixture struct is not the contract.
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.SkipObjectResolution)
		if err != nil {
			return nil, fmt.Errorf("parsing %s: %w", name, err)
		}
		for _, decl := range file.Decls {
			generic, ok := decl.(*ast.GenDecl)
			if !ok || generic.Tok != token.TYPE {
				continue
			}
			for _, spec := range generic.Specs {
				typeSpec, ok := spec.(*ast.TypeSpec)
				if !ok {
					continue
				}
				pkg.named[typeSpec.Name.Name] = true
				if structType, ok := typeSpec.Type.(*ast.StructType); ok {
					structTypes[typeSpec.Name.Name] = structType
				}
			}
		}
	}

	for name, structType := range structTypes {
		var fields []goField
		for _, field := range structType.Fields.List {
			if len(field.Names) != 1 {
				return nil, fmt.Errorf("%s: embedded and grouped fields are not supported in contract structs", name)
			}
			jsonName, omitEmpty := jsonTag(field)
			if jsonName == "" || jsonName == "-" {
				continue
			}
			typeText := exprString(fset, field.Type)
			_, isPointer := field.Type.(*ast.StarExpr)
			array, isArray := field.Type.(*ast.ArrayType)
			isSlice := isArray && array.Len == nil
			_, isStruct := structTypes[typeText]
			fields = append(fields, goField{
				Name:      field.Names[0].Name,
				JSONName:  jsonName,
				Type:      typeText,
				OmitEmpty: omitEmpty,
				Pointer:   isPointer,
				Slice:     isSlice,
				Struct:    isStruct,
			})
		}
		pkg.structs[name] = fields
	}
	return pkg, nil
}

func jsonTag(field *ast.Field) (name string, omitEmpty bool) {
	if field.Tag == nil {
		return "", false
	}
	raw, err := strconv.Unquote(field.Tag.Value)
	if err != nil {
		return "", false
	}
	tag := reflectTag(raw, "json")
	parts := strings.Split(tag, ",")
	for _, option := range parts[1:] {
		if option == "omitempty" {
			omitEmpty = true
		}
	}
	return parts[0], omitEmpty
}

// reflectTag is the tiny subset of reflect.StructTag.Get needed here, kept local
// so the generator does not have to build a reflect.StructTag from AST text.
func reflectTag(tag, key string) string {
	value, ok := parseStructTag(tag)[key]
	if !ok {
		return ""
	}
	return value
}

func parseStructTag(tag string) map[string]string {
	out := map[string]string{}
	for tag != "" {
		i := 0
		for i < len(tag) && tag[i] == ' ' {
			i++
		}
		tag = tag[i:]
		i = 0
		for i < len(tag) && tag[i] != ':' && tag[i] != ' ' {
			i++
		}
		if i == 0 || i+1 >= len(tag) || tag[i] != ':' || tag[i+1] != '"' {
			break
		}
		name := tag[:i]
		tag = tag[i+1:]
		i = 1
		for i < len(tag) && tag[i] != '"' {
			if tag[i] == '\\' {
				i++
			}
			i++
		}
		if i >= len(tag) {
			break
		}
		quoted := tag[:i+1]
		tag = tag[i+1:]
		if value, err := strconv.Unquote(quoted); err == nil {
			out[name] = value
		}
	}
	return out
}

func exprString(fset *token.FileSet, expr ast.Expr) string {
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, fset, expr); err != nil {
		return ""
	}
	return buf.String()
}

// ---------------------------------------------------------------------------
// Classification — every $def must be placeable
// ---------------------------------------------------------------------------

// classify sorts every `$def` into one of the four kinds the contract uses and
// checks each one against the Go package. It returns the object defs, in name
// order, because those are the ones that get generated defaults.
func classify(defs map[string]any, pkg *goPackage) ([]string, error) {
	var objects []string
	var problems []string

	for _, name := range sortedKeys(defs) {
		def, ok := defs[name].(map[string]any)
		if !ok {
			problems = append(problems, fmt.Sprintf("$defs/%s is not an object", name))
			continue
		}
		switch {
		case def["type"] == "object":
			goName := exportedName(name)
			fields, ok := pkg.structs[goName]
			if !ok {
				problems = append(problems, fmt.Sprintf(
					"$defs/%s has no Go type: declare `type %s struct{…}` in types.go", name, goName))
				continue
			}
			problems = append(problems, checkFields(name, goName, def, fields)...)
			objects = append(objects, name)

		case def["anyOf"] != nil:
			problems = append(problems, checkUnion(name, def, pkg)...)

		case def["enum"] != nil:
			goName := exportedName(name)
			if !pkg.named[goName] {
				problems = append(problems, fmt.Sprintf(
					"$defs/%s is an enum with no Go type: declare `type %s string` and its constants", name, goName))
			}

		case knownScalars[name]:
			// A bounded number, inlined at every use. Nothing to declare.

		default:
			problems = append(problems, fmt.Sprintf(
				"$defs/%s is a kind this generator does not know (not an object, union, enum or known scalar)", name))
		}
	}

	if len(problems) > 0 {
		return nil, fmt.Errorf("the contract and the Go package disagree:\n  %s", strings.Join(problems, "\n  "))
	}
	return objects, nil
}

// checkFields pins the property set and the two `omitempty` rules.
func checkFields(defName, goName string, def map[string]any, fields []goField) []string {
	var problems []string
	properties, _ := def["properties"].(map[string]any)
	required := stringSet(def["required"])

	byJSON := map[string]goField{}
	for _, field := range fields {
		byJSON[field.JSONName] = field
	}

	for _, propName := range sortedKeys(properties) {
		prop, _ := properties[propName].(map[string]any)
		field, ok := byJSON[propName]
		if !ok {
			problems = append(problems, fmt.Sprintf("%s.%s has no Go field (add one to %s)", defName, propName, goName))
			continue
		}
		_, hasDefault := prop["default"]
		optional := !hasDefault && !required[propName]

		// The only fields that may be omitted are the ones zod itself omits: no
		// default and not required, so an absent key stays absent on both sides.
		// Everything else must appear on the wire or the two sides normalise
		// differently.
		switch {
		case optional && !field.OmitEmpty:
			problems = append(problems, fmt.Sprintf(
				"%s.%s has no default and is not required, so an absent key must stay absent: make %s.%s a pointer with `,omitempty`",
				defName, propName, goName, field.Name))
		case optional && !field.Pointer:
			problems = append(problems, fmt.Sprintf(
				"%s.%s is a genuine optional: %s.%s must be a pointer so \"absent\" and \"empty\" stay distinct",
				defName, propName, goName, field.Name))
		case !optional && field.OmitEmpty:
			problems = append(problems, fmt.Sprintf(
				"%s.%s always travels (it has a default or is required), so %s.%s must not carry `,omitempty`",
				defName, propName, goName, field.Name))
		}

		if nullable(prop) && !field.Pointer {
			problems = append(problems, fmt.Sprintf(
				"%s.%s is nullable — null means \"could not measure\" and a zero would claim otherwise: make %s.%s a pointer",
				defName, propName, goName, field.Name))
		}
	}

	for _, field := range fields {
		if _, ok := properties[field.JSONName]; !ok {
			problems = append(problems, fmt.Sprintf(
				"%s.%s (json:%q) has no property in $defs/%s — the contract does not carry it",
				goName, field.Name, field.JSONName, defName))
		}
	}
	return problems
}

// checkUnion verifies the branch table and the assumption the branch structs
// rest on: that they need no seeding of their own.
func checkUnion(defName string, def map[string]any, pkg *goPackage) []string {
	var problems []string
	branches, ok := unionBranches[defName]
	if !ok {
		return []string{fmt.Sprintf(
			"$defs/%s is a discriminated union with no branch table: add one to unionBranches in gen/main.go", defName)}
	}

	anyOf, _ := def["anyOf"].([]any)
	seen := map[string]bool{}
	for index, entry := range anyOf {
		branch, _ := entry.(map[string]any)
		properties, _ := branch["properties"].(map[string]any)
		typeProp, _ := properties["type"].(map[string]any)
		tag, _ := typeProp["const"].(string)
		if tag == "" {
			problems = append(problems, fmt.Sprintf(
				"$defs/%s branch %d has no `properties.type.const` — the discriminator is not recoverable from the schema", defName, index))
			continue
		}
		seen[tag] = true
		goName, ok := branches[tag]
		if !ok {
			problems = append(problems, fmt.Sprintf(
				"$defs/%s branch %q has no Go type: add it to unionBranches and declare the struct in envelope.go", defName, tag))
			continue
		}
		fields, ok := pkg.structs[goName]
		if !ok {
			problems = append(problems, fmt.Sprintf("$defs/%s branch %q maps to %s, which is not declared", defName, tag, goName))
			continue
		}
		problems = append(problems, checkFields(defName+"."+tag, goName, branch, fields)...)
		problems = append(problems, checkBranchDefaults(defName, tag, branch)...)
	}
	for tag := range branches {
		if !seen[tag] {
			problems = append(problems, fmt.Sprintf(
				"unionBranches has a stale entry: $defs/%s no longer has a %q branch", defName, tag))
		}
	}
	return problems
}

// checkBranchDefaults enforces what makes the hand-written branch structs safe.
//
// Branch structs get no generated seeder — they are decoded straight into, so
// every default inside one has to be a value Go already produces for a zero
// field (null, false, 0, ""). Today all four are. The moment somebody writes
// `.default('x')` or `.default([])` on a frame field, this fails and says so,
// rather than shipping a frame that reads differently in the two languages.
func checkBranchDefaults(defName, tag string, branch map[string]any) []string {
	var problems []string
	properties, _ := branch["properties"].(map[string]any)
	required := stringSet(branch["required"])
	for _, propName := range sortedKeys(properties) {
		prop, _ := properties[propName].(map[string]any)
		if value, ok := prop["default"]; ok && !isGoZero(value) {
			problems = append(problems, fmt.Sprintf(
				"$defs/%s branch %q: %s defaults to %s, which is not a Go zero value — a frame struct has no seeder, so this needs one",
				defName, tag, propName, jsonLiteral(value)))
		}
		// A `$ref` that may be absent would leave a Go struct field at its zero
		// value while zod applies the referenced type's defaults. Required refs are
		// fine: validation runs before decoding, so the key is always there.
		if _, isRef := prop["$ref"]; isRef && !required[propName] {
			problems = append(problems, fmt.Sprintf(
				"$defs/%s branch %q: %s references another type but is optional — an absent key would decode to a zero struct, not to the referenced defaults",
				defName, tag, propName))
		}
	}
	return problems
}

// ---------------------------------------------------------------------------
// defaults_gen.go
// ---------------------------------------------------------------------------

func renderDefaults(defs map[string]any, objects []string, pkg *goPackage) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString(generatedHeader)
	buf.WriteString(`
package protocol

import "encoding/json"

`)

	for _, defName := range objects {
		def := defs[defName].(map[string]any)
		goName := exportedName(defName)
		fields := map[string]goField{}
		for _, field := range pkg.structs[goName] {
			fields[field.JSONName] = field
		}
		properties, _ := def["properties"].(map[string]any)

		var seeds []string
		for _, propName := range sortedKeys(properties) {
			prop, _ := properties[propName].(map[string]any)
			value, ok := prop["default"]
			if !ok {
				continue
			}
			field := fields[propName]
			line, err := seedLine(defName, propName, prop, value, field)
			if err != nil {
				return nil, err
			}
			seeds = append(seeds, line)
		}

		fmt.Fprintf(&buf, "// New%s returns a new %s, seeded with every default the contract declares.\n", goName, goName)
		fmt.Fprintf(&buf, "// Build values this way rather than as a struct literal: a literal leaves\n")
		fmt.Fprintf(&buf, "// slices nil (they marshal to null, which the server rejects) and non-zero\n")
		fmt.Fprintf(&buf, "// defaults unset.\n")
		fmt.Fprintf(&buf, "func New%s() %s {\n\tvar value %s\n\tvalue.applyDefaults()\n\treturn value\n}\n\n", goName, goName, goName)

		fmt.Fprintf(&buf, "// applyDefaults writes the contract's defaults over a zero %s.\n", goName)
		fmt.Fprintf(&buf, "func (x *%s) applyDefaults() {\n", goName)
		for _, seed := range seeds {
			fmt.Fprintf(&buf, "\t%s\n", seed)
		}
		buf.WriteString("}\n\n")

		fmt.Fprintf(&buf, `// UnmarshalJSON seeds the defaults and then lets the incoming object write over
// them, which is what reproduces zod's "undefined -> default" at any depth: the
// standard decoder calls this same method for every nested object and every
// slice element, so %s inside a list is defaulted exactly like one at the root.
func (x *%s) UnmarshalJSON(data []byte) error {
	*x = %s{}
	x.applyDefaults()
	// A local type with the same fields and none of the methods — without it this
	// call would recurse into itself.
	type plain %s
	return json.Unmarshal(data, (*plain)(x))
}

`, goName, goName, goName, goName)
	}

	return format.Source(buf.Bytes())
}

// seedLine renders one default assignment.
func seedLine(defName, propName string, prop map[string]any, value any, field goField) (string, error) {
	where := fmt.Sprintf("%s.%s", defName, propName)
	switch {
	case value == nil:
		if !field.Pointer {
			return "", fmt.Errorf("%s defaults to null but %s is not a pointer", where, field.Name)
		}
		return fmt.Sprintf("x.%s = nil", field.Name), nil

	case isEmptyArray(value):
		if !field.Slice {
			return "", fmt.Errorf("%s defaults to [] but %s is not a slice", where, field.Name)
		}
		// An empty slice, never nil: a nil slice marshals to null and takes the
		// whole frame down with it.
		return fmt.Sprintf("x.%s = %s{}", field.Name, field.Type), nil

	case isObject(value):
		// TRAP 1 (see the file header): a defaulted referenced object means "this
		// object's own defaults", whether the artefact spells the effective object
		// out or retains `{}`. Recurse by type; never copy a map literal.
		if _, isRef := prop["$ref"]; !isRef {
			return "", fmt.Errorf("%s has an object default but does not reference a named type, so its real defaults are unknowable", where)
		}
		if !field.Struct || field.Pointer {
			return "", fmt.Errorf("%s defaults to its own defaults, so %s must be an inline struct, not a pointer", where, field.Name)
		}
		return fmt.Sprintf("x.%s.applyDefaults()", field.Name), nil

	default:
		if field.Pointer || field.Slice {
			return "", fmt.Errorf("%s defaults to %s but %s is a pointer or slice", where, jsonLiteral(value), field.Name)
		}
		return fmt.Sprintf("x.%s = %s", field.Name, goLiteral(value)), nil
	}
}

// ---------------------------------------------------------------------------
// consts_gen.go
// ---------------------------------------------------------------------------

func renderConstants(constants map[string]any) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString(generatedHeader)
	buf.WriteString(`
package protocol

// The values a schema cannot express, and therefore the first things to drift:
// the header an agent authenticates with, the paths it dials, the caps it applies
// before anything crosses the wire.

const (
`)
	for _, name := range sortedKeys(constants) {
		if strings.HasPrefix(name, "$") || name == "_generated" {
			continue
		}
		switch value := constants[name].(type) {
		case map[string]any:
			// A grouped constant (DIFF_CAPS) flattens to one const per member, so
			// nothing here needs a hand-written Go type to hang off.
			for _, member := range sortedKeys(value) {
				fmt.Fprintf(&buf, "\t%s%s = %s\n", exportedConstName(name), exportedName(member), goLiteral(value[member]))
			}
		case string, json.Number, bool:
			fmt.Fprintf(&buf, "\t%s = %s\n", exportedConstName(name), goLiteral(value))
		default:
			return nil, fmt.Errorf("constant %s has a shape this generator cannot emit (%T)", name, value)
		}
	}
	buf.WriteString(")\n")
	return format.Source(buf.Bytes())
}

// ---------------------------------------------------------------------------
// schema_hash.go
// ---------------------------------------------------------------------------

func renderHashes(schemaBytes, constantsBytes []byte) []byte {
	var buf bytes.Buffer
	buf.WriteString(generatedHeader)
	fmt.Fprintf(&buf, `
package protocol

// The contract these sources were generated from, pinned.
//
// A Go test hashes packages/protocol/schema/*.json and compares. That is the
// tripwire for the one failure this package cannot otherwise see: somebody edits
// the zod contract, regenerates the JSON artefacts, and does NOT re-run
// `+"`go generate ./...`"+`. The agent would then keep validating against a stale
// contract and quietly disagree with the server about a field neither side
// mentions. Re-running the generator is the fix.

const (
	// SchemaSHA256 is sha256 of packages/protocol/schema/protocol.schema.json.
	SchemaSHA256 = %q
	// ConstantsSHA256 is sha256 of packages/protocol/schema/constants.json.
	ConstantsSHA256 = %q
)
`, sha256Hex(schemaBytes), sha256Hex(constantsBytes))
	formatted, err := format.Source(buf.Bytes())
	if err != nil {
		// The template is fixed; a failure here is a bug in this file.
		panic(err)
	}
	return formatted
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const generatedHeader = `// Code generated by internal/protocol/gen. DO NOT EDIT.
//
// Source: packages/protocol/schema (generated in turn from packages/protocol/src/index.ts).
// Regenerate with: go generate ./internal/protocol
`

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func stringSet(value any) map[string]bool {
	out := map[string]bool{}
	list, _ := value.([]any)
	for _, entry := range list {
		if text, ok := entry.(string); ok {
			out[text] = true
		}
	}
	return out
}

// nullable reports the `anyOf: [<thing>, {type: null}]` shape zod emits for
// `.nullable()`.
func nullable(prop map[string]any) bool {
	options, ok := prop["anyOf"].([]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if entry, ok := option.(map[string]any); ok && entry["type"] == "null" {
			return true
		}
	}
	return false
}

func isEmptyArray(value any) bool {
	list, ok := value.([]any)
	return ok && len(list) == 0
}

func isObject(value any) bool {
	_, ok := value.(map[string]any)
	return ok
}

// isGoZero reports whether Go already produces this value for an unset field.
func isGoZero(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case bool:
		return !typed
	case string:
		return typed == ""
	case json.Number:
		return typed.String() == "0"
	default:
		return false
	}
}

func goLiteral(value any) string {
	switch typed := value.(type) {
	case string:
		return strconv.Quote(typed)
	case bool:
		return strconv.FormatBool(typed)
	case json.Number:
		return typed.String()
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func jsonLiteral(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(encoded)
}

// exportedName turns a camelCase schema name into its Go spelling. The mapping is
// derived rather than tabulated, so a new `$def` demands a Go type of the obvious
// name instead of quietly needing an entry somewhere.
func exportedName(name string) string {
	if name == "" {
		return ""
	}
	return strings.ToUpper(name[:1]) + name[1:]
}

// exportedConstName turns SCREAMING_SNAKE into Go's CamelCase, keeping the
// initialisms Go style wants capitalised whole.
func exportedConstName(name string) string {
	initialisms := map[string]string{"WS": "WS", "URL": "URL", "ID": "ID", "API": "API", "OS": "OS"}
	var out strings.Builder
	for _, word := range strings.Split(name, "_") {
		if word == "" {
			continue
		}
		upper := strings.ToUpper(word)
		if fixed, ok := initialisms[upper]; ok {
			out.WriteString(fixed)
			continue
		}
		out.WriteString(upper[:1] + strings.ToLower(word[1:]))
	}
	return out.String()
}

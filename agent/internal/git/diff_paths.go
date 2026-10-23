package git

import (
	"strconv"
	"strings"
)

// Git uses C quoting, including octal UTF-8 bytes, independently of JSON quoting.
func patchQuotedPath(input string) (string, int, bool) {
	if !strings.HasPrefix(input, `"`) {
		return "", 0, false
	}
	for index := 1; index < len(input); index++ {
		if input[index] == '\\' {
			index++
			continue
		}
		if input[index] == '"' {
			value, err := strconv.Unquote(input[:index+1])
			return value, index + 1, err == nil
		}
	}
	return "", 0, false
}

func patchPathPair(body string) (string, string, bool) {
	if strings.HasPrefix(body, `"`) {
		old, end, ok := patchQuotedPath(body)
		if !ok || end >= len(body) || body[end] != ' ' {
			return "", "", false
		}
		path, ok := patchPathValue(body[end+1:])
		if !ok || !strings.HasPrefix(old, "a/") || !strings.HasPrefix(path, "b/") {
			return "", "", false
		}
		return old[2:], path[2:], true
	}
	type pair struct{ old, path string }
	candidates := []pair{}
	for index := 0; index < len(body); index++ {
		if !strings.HasPrefix(body[index:], " b/") && !strings.HasPrefix(body[index:], ` "b/`) {
			continue
		}
		old := body[:index]
		path, ok := patchPathValue(body[index+1:])
		if ok && strings.HasPrefix(old, "a/") && strings.HasPrefix(path, "b/") {
			candidates = append(candidates, pair{old[2:], path[2:]})
		}
	}
	if len(candidates) == 1 {
		return candidates[0].old, candidates[0].path, true
	}
	// A repeated unquoted path can contain the separator itself. Extended headers
	// disambiguate renames; identical source/destination paths need no guessing.
	var match *pair
	for index := range candidates {
		if candidates[index].old == candidates[index].path {
			if match != nil {
				return "", "", false
			}
			match = &candidates[index]
		}
	}
	if match != nil {
		return match.old, match.path, true
	}
	return "", "", false
}

func patchPathValue(input string) (string, bool) {
	if !strings.HasPrefix(input, `"`) {
		return input, input != ""
	}
	value, end, ok := patchQuotedPath(input)
	return value, ok && end == len(input)
}

// File markers may end with a tab/timestamp. Tabs within a name are C quoted.
func patchMarkerPath(input, prefix string) (string, bool) {
	var value string
	var ok bool
	if strings.HasPrefix(input, `"`) {
		value, _, ok = patchQuotedPath(input)
	} else {
		value = strings.SplitN(input, "\t", 2)[0]
		ok = value != ""
	}
	if !ok {
		return "", false
	}
	if value == "/dev/null" {
		return "", true
	}
	return strings.TrimPrefix(value, prefix), true
}

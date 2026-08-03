package git

import "unicode/utf8"

// clip truncates s to at most max CHARACTERS.
//
// The TypeScript used `String.prototype.slice`, which counts UTF-16 code units.
// Go's obvious equivalent — slicing bytes — would cut a multi-byte rune in half
// and put a U+FFFD into a commit subject the moment somebody writes one in
// Korean. Counting runes is both safe and the unit the contract's own
// `maxLength` checks use, so the two sides agree on what "1024" means.
func clip(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(s) <= max {
		// Fast path: a string with fewer BYTES than the cap cannot have more runes.
		return s
	}
	count := 0
	for index := range s {
		if count == max {
			return s[:index]
		}
		count++
	}
	return s
}

// tooLong reports whether s exceeds max characters, using the same unit as clip.
func tooLong(s string, max int) bool {
	return utf8.RuneCountInString(s) > max
}

// sliceFrom is JavaScript's `String.prototype.slice(n)`: a string shorter than n
// yields "" instead of panicking. The patch parser slices at fixed offsets that
// hold for every line git actually prints, and this keeps a malformed line a
// parsing miss rather than a crashed pass.
func sliceFrom(s string, n int) string {
	if n >= len(s) {
		return ""
	}
	return s[n:]
}

// field returns bits[index], or "" — JavaScript's out-of-range index.
func field(bits []string, index int) string {
	if index < 0 || index >= len(bits) {
		return ""
	}
	return bits[index]
}

// charAt returns the byte at index as a string, or fallback when the string is
// shorter. Byte indexing is correct here: every caller reads git's own status
// letters, which are ASCII.
func charAt(s string, index int, fallback string) string {
	if index < 0 || index >= len(s) {
		return fallback
	}
	return s[index : index+1]
}

// ptr is the one-liner that keeps every nullable contract field a pointer. A
// plain value there would read as a real measurement instead of "not measured".
func ptr[T any](value T) *T {
	return &value
}

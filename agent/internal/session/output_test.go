package session

import (
	"bytes"
	"strings"
	"testing"
)

func TestWindowTitleFilter(t *testing.T) {
	t.Run("[TC-PDTERM-022] title removal is Unicode-safe across every chunk boundary", func(t *testing.T) {
		for _, test := range []struct{ name, input, want string }{
			{"bell", "draft\x1b]0;\u25d1 \uc911\ub2e8\ub41c \uc791\uc5c5 \ubcd1\ub82c \uc7ac\uac1c\aREADY", "draftREADY"},
			{"string terminator", "a\x1b]2;\ub41c\u671d\x1b\\b", "ab"},
			{"icon title", "a\x1b]1;icon\ab", "ab"},
			{"C1 introducer and terminator", "a\x9d2;\ub41c\x9cb", "ab"},
			{"leading zeroes", "a\x1b]002;title\ab", "ab"},
			{"visible Unicode and colors", "\x1b[31m\ub41c\u671d\x1b[0m", "\x1b[31m\ub41c\u671d\x1b[0m"},
			{"hyperlink", "\x1b]8;id=work;https://example.test/path\x1b\\label\x1b]8;;\x1b\\", "\x1b]8;id=work;https://example.test/path\x1b\\label\x1b]8;;\x1b\\"},
			{"color queries", "\x1b]11;?\a\x1b]4;1;?\x1b\\", "\x1b]11;?\a\x1b]4;1;?\x1b\\"},
			{"cancelled title", "a\x1b]0;unfinished\x18b", "ab"},
			{"new escape cancels title", "a\x1b]0;unfinished\x1b[31mRED", "a\x1b[31mRED"},
			{"nested title introducer", "a\x1b]0;old\x1b]2;\ub41c suffix\ab", "ab"},
		} {
			for size := 1; size <= len(test.input); size++ {
				var filter windowTitleFilter
				var output []byte
				for at := 0; at < len(test.input); at += size {
					output = append(output, filter.filter([]byte(test.input[at:min(at+size, len(test.input))]))...)
				}
				if string(output) != test.want {
					t.Fatalf("%s, chunk size %d: got %q, want %q", test.name, size, output, test.want)
				}
			}
		}
	})
	t.Run("[TC-PDTERM-022] unterminated titles cannot accumulate an unbounded buffer", func(t *testing.T) {
		var filter windowTitleFilter
		_ = filter.filter([]byte("\x1b]0;"))
		for range 256 {
			if output := filter.filter(bytes.Repeat([]byte("\ub41c title"), 1024)); len(output) != 0 {
				t.Fatal("unterminated title leaked into the screen")
			}
		}
		if len(filter.prefix) > 18 {
			t.Fatal("unbounded title prefix")
		}
		if output := string(filter.filter([]byte("\aREADY"))); output != "READY" {
			t.Fatalf("title did not terminate: %q", output)
		}
		var malformed windowTitleFilter
		input := "\x1b]" + strings.Repeat("9", 1024) + ";value\a"
		if output := string(malformed.filter([]byte(input))); output != input {
			t.Fatal("unrecognized OSC command changed")
		}
	})
}

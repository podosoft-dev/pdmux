package session

import (
	"strings"
	"testing"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/podosoft-dev/pdmux/agent/internal/vt"
)

// OSC 8 hyperlinks through the renderer. A login link printed as a hyperlink
// (as Claude Code does) used to reach the viewer as the URL's own text in every
// cell, so the row showed the start of the URL over and over and the rest was
// cut off.

const testLink = "https://login.example.test/oauth/authorize?z-9K_2O4KQ8tH8FlOxhqS04"

func linkCells(term *vt.Emulator, y int) (text, url string, linked int) {
	var b strings.Builder
	for x := range term.Width() {
		c := term.CellAt(x, y)
		if c == nil || c.IsZero() {
			continue
		}
		b.WriteString(c.Content)
		if c.Link.URL != "" {
			url = c.Link.URL
			linked++
		}
	}
	return strings.TrimRight(b.String(), " "), url, linked
}

func TestNativeHyperlinks(t *testing.T) {
	printed := "see \x1b]8;;" + testLink + "\x1b\\" + testLink + "\x1b]8;;\x1b\\ done\r\n$ "
	t.Run("[TC-PDTERM-190] a hyperlinked URL reaches the viewer as one link over its own characters", func(t *testing.T) {
		e, s, v := wrapSession(t, 40, 6)
		data := draw(t, e, s, v, printed, true)
		// The URL's text is drawn once, by its cells; the link itself opens
		// for each piece of the row (the wrap join draws three).
		if n := strings.Count(ansi.Strip(data), "login.example.test"); n != 1 {
			t.Fatalf("the URL is drawn as text %d times: %q", n, data)
		}
		replay := vt.NewEmulator(40, 6)
		defer replay.Close()
		_, _ = replay.Write([]byte(data))
		sameScreen(t, s, replay)
		if got := strings.Join(lineStrings(replay), "|"); !strings.Contains(got, "see "+testLink+" done") {
			t.Fatalf("the viewer cannot read the URL back: %q", got)
		}
		total := 0
		for y := range 3 {
			text, url, linked := linkCells(replay, y)
			_, want, wantLinked := linkCells(s.vt, y)
			if url != want || linked != wantLinked {
				t.Fatalf("row %d %q: viewer link %q on %d cells, session %q on %d", y, text, url, linked, want, wantLinked)
			}
			total += linked
		}
		if total != len(testLink) {
			t.Fatalf("%d cells carry the link, want %d", total, len(testLink))
		}
		if _, url, _ := linkCells(replay, 3); url != "" {
			t.Fatal("the prompt row after the link carries it")
		}
	})
	t.Run("[TC-PDTERM-190] history gives the link's text once", func(t *testing.T) {
		e, s, v := wrapSession(t, 40, 6)
		draw(t, e, s, v, printed, true)
		lines, _, err := e.History(s.info.ID)
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(lines, "\n")
		if got := ansi.Strip(joined); !strings.Contains(got, "see "+testLink+" done") || strings.Count(got, testLink) != 1 {
			t.Fatalf("history text %q", got)
		}
		if !strings.Contains(joined, "\x1b]8;;"+testLink+"\x1b\\") {
			t.Fatalf("history lost the link: %q", joined)
		}
	})
	t.Run("[TC-PDTERM-190] link parameters are kept and a link with control characters stays plain text", func(t *testing.T) {
		withID := renderCells([]uv.Cell{{Content: "a", Width: 1, Link: uv.Link{URL: testLink, Params: "id=login"}}, {Content: "b", Width: 1}})
		if want := "\x1b]8;id=login;" + testLink + "\x1b\\a" + endHyperlink + "b"; !strings.Contains(withID, want) {
			t.Fatalf("got %q, want it to contain %q", withID, want)
		}
		for _, link := range []uv.Link{
			{URL: "https://example.test/\x1b]52;c;aGk=\x07"},
			{URL: "https://example.test/\u009c\x1b[2J"},
			{URL: "https://example.test/", Params: "id=x;y"},
			{URL: "https://example.test/\xff"},
		} {
			out := renderCells([]uv.Cell{{Content: "x", Width: 1, Link: link}})
			if strings.Contains(out, "]8;") || strings.Contains(out, "example.test") || ansi.Strip(out) != "x" {
				t.Fatalf("unsafe link %q rendered as %q", link.URL, out)
			}
		}
	})
}

package git

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

func TestRemote(t *testing.T) {
	ctx := context.Background()

	// A runner that answers with canned `ls-remote` output and records what it was
	// asked for. Real network calls in a unit test would measure somebody's DNS.
	stub := func(out string, err error) (Runner, *[]string) {
		seen := &[]string{}
		return func(_ context.Context, args []string, _ CallOptions) (string, error) {
			*seen = append(*seen, strings.Join(args, " "))
			return out, err
		}, seen
	}

	t.Run("[TC-PDGIT-013] reads the remote's branches and tags as they are now", func(t *testing.T) {
		run, seen := stub(strings.Join([]string{
			"9c7dad0c8af297deed9221f2b651351b70c9c9f5\trefs/heads/main",
			"3f637f11f52b3247ef79082d10f8076ff00b899b\trefs/heads/feat/graph-tabs",
			"beb081311e51e82d4a5d90bf476516d3fec2e576\trefs/tags/v0.4.0",
			// A tag that points at a tag object also advertises what it resolves to.
			// Both rows carry the same name, and drawing two tags called v0.4.0 would
			// be a lie about the remote.
			"5d87eb5cafe1234567890abcdef1234567890abc\trefs/tags/v0.4.0^{}",
			// HEAD is advertised too and is not a branch anybody can draw.
			"9c7dad0c8af297deed9221f2b651351b70c9c9f5\tHEAD",
		}, "\n"), nil)

		refs, err := ReadRemote(ctx, run, 0)
		if err != nil {
			t.Fatalf("ReadRemote: %v", err)
		}
		if len(refs) != 3 {
			t.Fatalf("refs = %+v, want three (two branches and one tag)", refs)
		}
		if refs[0].Name != "main" || refs[0].Kind != protocol.RemoteBranch {
			t.Fatalf("first ref = %+v", refs[0])
		}
		if refs[2].Name != "v0.4.0" || refs[2].Kind != protocol.RemoteTag {
			t.Fatalf("tag ref = %+v", refs[2])
		}
		// ⚠ THE SUBCOMMAND IS THE ASSERTION. `ls-remote` reads the remote and writes
		// nothing; `fetch` would answer the same question by changing somebody's
		// repository. Only the first is on the read-only whitelist, and the two are
		// one word apart at the call site.
		if len(*seen) != 1 || !strings.HasPrefix((*seen)[0], "ls-remote ") {
			t.Fatalf("ran %v, want a single ls-remote", *seen)
		}
	})

	t.Run("[TC-PDGIT-013] stops at the cap rather than growing without bound", func(t *testing.T) {
		lines := make([]string, 0, 50)
		for i := 0; i < 50; i++ {
			lines = append(lines, "9c7dad0c8af297deed9221f2b651351b70c9c9f5\trefs/heads/b"+string(rune('a'+i%26)))
		}
		run, _ := stub(strings.Join(lines, "\n"), nil)
		refs, err := ReadRemote(ctx, run, 10)
		if err != nil {
			t.Fatalf("ReadRemote: %v", err)
		}
		if len(refs) != 10 {
			t.Fatalf("refs = %d, want the cap of 10", len(refs))
		}
	})

	/**
	 * ⚠ AN UNREACHABLE REMOTE IS AN ANSWER, NOT SILENCE. No remote configured, no
	 * network, a credential that expired — each is a fact about that checkout, and
	 * a screen that showed nothing would leave a person wondering whether the
	 * button worked.
	 */
	t.Run("[TC-PDGIT-013] reports an unreachable remote instead of sending nothing", func(t *testing.T) {
		run, _ := stub("", errors.New("git ls-remote exited 128"))
		snapshot := CollectRemoteSnapshot(ctx, RemoteOptions{
			Path: "/repo", Name: "repo", Run: run, Now: func() int64 { return 1_784_000_000 },
		})
		if snapshot.Remote == nil {
			t.Fatal("no remote check on the snapshot: the button would look broken")
		}
		if snapshot.Remote.Error == nil {
			t.Fatal("the failure was swallowed")
		}
		if len(snapshot.Remote.Refs) != 0 {
			t.Fatalf("refs = %+v, want none alongside an error", snapshot.Remote.Refs)
		}
		// ⚠ PARTIAL, like a detail answer. Refs and commit rows did not change
		// because somebody asked about the remote, and rebuilding them would spend a
		// full graph pass to deliver one list of shas.
		if !snapshot.Partial {
			t.Fatal("the frame claims to be a full snapshot")
		}
		if len(snapshot.Commits) != 0 || len(snapshot.Refs) != 0 {
			t.Fatal("a remote check rebuilt the graph")
		}
	})

	t.Run("[TC-PDGIT-013] carries the time of the check, not of the last pass", func(t *testing.T) {
		run, _ := stub("9c7dad0c8af297deed9221f2b651351b70c9c9f5\trefs/heads/main", nil)
		snapshot := CollectRemoteSnapshot(ctx, RemoteOptions{
			Path: "/repo", Name: "repo", Run: run, Now: func() int64 { return 1_784_000_123 },
		})
		if snapshot.Remote.CheckedAt != 1_784_000_123 {
			t.Fatalf("checkedAt = %d", snapshot.Remote.CheckedAt)
		}
	})
}

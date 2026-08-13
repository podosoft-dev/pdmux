package agent

// The three passes: the cheap one that runs every few seconds, the expensive one
// that walks every configured checkout, and the partial answer to a click.
//
// Each of them is also a guard. A pass that overlaps itself queues probes behind
// each other until the agent is doing nothing but collecting, and a pass that
// runs while the socket is down is pure waste — the result has nowhere to go and
// the next pass will measure again anyway.

import (
	"context"
	"encoding/base64"
	"errors"
	"time"

	"github.com/podosoft-dev/pdmux/agent/internal/collect"
	"github.com/podosoft-dev/pdmux/agent/internal/fs"
	"github.com/podosoft-dev/pdmux/agent/internal/git"
	"github.com/podosoft-dev/pdmux/agent/internal/log"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/term"
)

// heartbeatPass takes one pass over the host and ships it.
//
// It never fails as a whole: every collector inside contributes its own
// nil/empty value on failure, because an agent that goes silent because `df`
// hung looks exactly like a host that went down.
func (a *Agent) heartbeatPass(ctx context.Context) {
	if !a.heartbeatRunning.CompareAndSwap(false, true) {
		return
	}
	defer a.heartbeatRunning.Store(false)
	if !a.client.Connected() {
		return
	}
	// Read straight off the store — a write that failed since the last beat must
	// show up on this one.
	a.diagnostics.NoteLedger(a.store.Unavailable())
	beat := collect.Heartbeat(ctx, a.Config(), a.deps)
	a.client.Send(&protocol.HeartbeatFrame{Heartbeat: beat})
}

// gitPass rediscovers the configured roots and ships a snapshot of each
// checkout. Everything it does is read-only, by construction of internal/git.
func (a *Agent) gitPass(ctx context.Context) {
	if !a.gitRunning.CompareAndSwap(false, true) {
		return
	}
	defer a.gitRunning.Store(false)
	config := a.Config()
	if !a.client.Connected() || len(config.GitRoots) == 0 {
		return
	}

	discovery := git.DiscoverDetailed(ctx, config.GitRoots, 0)
	a.mu.Lock()
	a.repos = discovery.Repos
	a.mu.Unlock()
	// The scan already knows which roots yielded nothing; the next heartbeat
	// reports them without looking at the filesystem again.
	a.diagnostics.NoteGitRoots(discovery.MissingRoots)

	batch := []protocol.RepoSnapshot{}
	bytes := 0
	flush := func() {
		if len(batch) == 0 {
			return
		}
		frame := protocol.NewReposFrame(time.Now().Unix())
		frame.Repos = batch
		a.client.Send(frame)
		batch = []protocol.RepoSnapshot{}
		bytes = 0
	}
	for _, repo := range discovery.Repos {
		if ctx.Err() != nil {
			// Shutting down. Whatever is already batched has nowhere to go.
			return
		}
		snapshot := git.CollectRepoSnapshot(ctx, git.SnapshotOptions{
			Path:          repo.Path,
			Name:          repo.Name,
			Limit:         config.GitLimit,
			DetailBudget:  config.GitDetailBudget,
			Ledger:        a.ledger,
			StatusFileCap: config.StatusFileCap,
			BodyMaxChars:  config.BodyMaxChars,
		})
		batch = append(batch, snapshot)
		bytes += estimateBytes(snapshot)
		if len(batch) >= repoFrameMaxCount || bytes >= repoFrameMaxBytes {
			flush()
		}
	}
	flush()
}

// detailPass answers an explicit request for specific commits (a click in the
// UI) with a PARTIAL snapshot — details only, no refs and no commit rows. Those
// rows have not changed since the last pass and the server already has them.
func (a *Agent) detailPass(ctx context.Context, repoPath string, shas []string) {
	repo, known := a.findRepo(repoPath)
	if !known {
		// The path came from the server. Answering it would mean running git in a
		// directory this agent never discovered.
		a.logger.Warn("Ignoring detail request for unknown repo", log.F("repoPath", repoPath))
		return
	}
	snapshot := git.CollectDetailSnapshot(ctx, git.DetailOptions{
		Path:         repo.Path,
		Name:         repo.Name,
		Shas:         shas,
		Ledger:       a.ledger,
		BodyMaxChars: a.Config().BodyMaxChars,
	})
	frame := protocol.NewReposFrame(time.Now().Unix())
	frame.Repos = []protocol.RepoSnapshot{snapshot}
	a.client.Send(frame)
}

// treePass answers "which files existed at this commit" with a PARTIAL snapshot.
//
// ⚠ ONLY EVER BECAUSE SOMEBODY CLICKED, never on the timer. The tree of a large
// checkout is thousands of paths, and collecting it for every commit in the
// window would multiply the periodic pass by the size of the repository to
// deliver something nobody has opened.
func (a *Agent) treePass(ctx context.Context, repoPath string, sha string) {
	repo, known := a.findRepo(repoPath)
	if !known {
		// The path came from the server. Answering it would mean running git in a
		// directory this agent never discovered.
		a.logger.Warn("Ignoring tree request for unknown repo", log.F("repoPath", repoPath))
		return
	}
	snapshot := git.CollectTreeSnapshot(ctx, git.TreeOptions{Path: repo.Path, Name: repo.Name, SHA: sha})
	frame := protocol.NewReposFrame(time.Now().Unix())
	frame.Repos = []protocol.RepoSnapshot{snapshot}
	a.client.Send(frame)
}

// blobPass answers "what is in this file at this commit", one file per request.
//
// ⚠ ONE FILE, NOT THE TREE'S WORTH. The whole point of splitting this from
// `treePass` is that a person opens a handful of files out of thousands; sending
// the contents of everything the tree listed would be the largest frame in the
// protocol by orders of magnitude, for content that is never rendered.
func (a *Agent) blobPass(ctx context.Context, repoPath string, sha string, path string) {
	repo, known := a.findRepo(repoPath)
	if !known {
		a.logger.Warn("Ignoring file request for unknown repo", log.F("repoPath", repoPath))
		return
	}
	snapshot := git.CollectBlobSnapshot(ctx, git.BlobOptions{
		Path: repo.Path, Name: repo.Name, SHA: sha, FilePath: path,
	})
	frame := protocol.NewReposFrame(time.Now().Unix())
	frame.Repos = []protocol.RepoSnapshot{snapshot}
	a.client.Send(frame)
}

// remotePass asks every discovered checkout what its remote holds right now.
//
// ⚠ THIS IS THE ONLY PASS THAT LEAVES THE MACHINE, and it exists as its own pass
// for that reason. `ls-remote` writes nothing — it downloads no objects and moves
// no ref, so the repository somebody is working in is unchanged — but it does
// wait on a network, and a host with one unreachable remote would otherwise make
// the periodic git pass as slow as that timeout, every interval, forever.
//
// One frame per repository rather than a batch: a person pressed a button and the
// first answer should appear without waiting for the slowest remote on the host.
func (a *Agent) remotePass(ctx context.Context) {
	a.mu.Lock()
	repos := append([]git.DiscoveredRepo(nil), a.repos...)
	a.mu.Unlock()
	for _, repo := range repos {
		if ctx.Err() != nil {
			return
		}
		snapshot := git.CollectRemoteSnapshot(ctx, git.RemoteOptions{Path: repo.Path, Name: repo.Name})
		frame := protocol.NewReposFrame(time.Now().Unix())
		frame.Repos = []protocol.RepoSnapshot{snapshot}
		a.client.Send(frame)
	}
}

// findRepo looks a request up against what the last scan actually found.
func (a *Agent) findRepo(path string) (git.DiscoveredRepo, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, repo := range a.repos {
		if repo.Path == path {
			return repo, true
		}
	}
	return git.DiscoveredRepo{}, false
}

// estimateBytes is a cheap stand-in for the encoded size of a snapshot: the
// patch lines dominate it by orders of magnitude, and the point is only to
// decide when to flush a batch, not to predict the frame to the byte.
func estimateBytes(snapshot protocol.RepoSnapshot) int {
	bytes := 512
	for _, detail := range snapshot.Details {
		for _, file := range detail.Files {
			for _, line := range file.Lines {
				bytes += len(line) + 1
			}
		}
	}
	return bytes
}

// fsListPass answers "what is in this directory", one level, under the home.
//
// ⚠ THE ROOT IS OPENED HERE AND NOWHERE ELSE, per request. The path from the
// server is relative to it and is resolved THROUGH it, so this pass never
// assembles a filesystem path of its own — that is the whole security property
// (`internal/fs`), and building one here would quietly throw it away.
//
// ⚠ AND A FAILURE TRAVELS IN THE FRAME, the way a tree's does. A home that has
// gone missing, a directory this account cannot read: both are facts the screen
// has to be able to state, and sending nothing leaves it looking like the click
// was lost.
func (a *Agent) fsListPass(_ context.Context, id string, path string) {
	home := term.HomeDir()
	root, err := fs.Open(home)
	if err != nil {
		dir := protocol.NewFsDir()
		dir.RequestID = id
		dir.Path = path
		a.client.Send(protocol.NewFsDirFrame(fsFailedDir(dir, err)))
		return
	}
	defer root.Close()
	dir := fs.List(root, path, 0)
	dir.RequestID = id
	// For the path bar only. It is never accepted back as an address — see the
	// note on the field in the contract.
	dir.Home = home
	a.client.Send(protocol.NewFsDirFrame(dir))
}

// fsGetPass answers "give me these bytes of this file".
//
// ⚠ ONE SLICE PER REQUEST, AND NOTHING KEPT BETWEEN THEM. The root and the file
// are opened and closed inside the pass, so a download the browser abandons
// leaves nothing on this host — no handle, no timer, nothing to reap. The cost is
// one open per megabyte, which is nothing beside the transfer itself.
func (a *Agent) fsGetPass(_ context.Context, id string, path string, offset int, length int) {
	root, err := fs.Open(term.HomeDir())
	if err != nil {
		chunk := protocol.NewFsChunk()
		chunk.RequestID = id
		chunk.Path = path
		chunk.Offset = offset
		a.client.Send(protocol.NewFsChunkFrame(fsFailedChunk(chunk, err)))
		return
	}
	defer root.Close()
	chunk := fs.Chunk(root, path, int64(offset), length)
	chunk.RequestID = id
	a.client.Send(protocol.NewFsChunkFrame(chunk))
}

// fsPutPass writes one slice of an upload.
//
// ⚠ THE BYTES ARE NEVER LOGGED, not even their length at info level. An upload is
// the surface most likely to carry a secret — the same argument the MCP gateway
// makes for command arguments — so what is recorded is that a write happened and
// where, and the answer frame carries no content either.
func (a *Agent) fsPutPass(_ context.Context, id string, path string, offset int, data string, create bool) {
	wrote := protocol.NewFsWrote()
	wrote.RequestID = id
	wrote.Path = path

	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		a.client.Send(protocol.NewFsWroteFrame(fsFailedWrote(wrote, errors.New("slice is not base64"))))
		return
	}
	root, err := fs.Open(term.HomeDir())
	if err != nil {
		a.client.Send(protocol.NewFsWroteFrame(fsFailedWrote(wrote, err)))
		return
	}
	defer root.Close()
	result := fs.Write(root, path, int64(offset), raw, create)
	result.RequestID = id
	a.client.Send(protocol.NewFsWroteFrame(result))
}

// fsDeletePass removes one entry.
func (a *Agent) fsDeletePass(_ context.Context, id string, path string, recursive bool) {
	removed := protocol.NewFsRemoved()
	removed.RequestID = id
	removed.Path = path

	root, err := fs.Open(term.HomeDir())
	if err != nil {
		a.client.Send(protocol.NewFsRemovedFrame(fsFailedRemoved(removed, err)))
		return
	}
	defer root.Close()
	result := fs.Remove(root, path, recursive)
	result.RequestID = id
	a.client.Send(protocol.NewFsRemovedFrame(result))
}

// fsReadPass answers "what is in this file", one file per request — split from
// the listing for the reason `blobPass` records: a person opens a handful of
// files out of a directory, and sending every file's contents would be the
// largest frame in the protocol for content nobody renders.
func (a *Agent) fsReadPass(_ context.Context, id string, path string) {
	root, err := fs.Open(term.HomeDir())
	if err != nil {
		file := protocol.NewFsFile()
		file.RequestID = id
		file.Path = path
		a.client.Send(protocol.NewFsFileFrame(fsFailedFile(file, err)))
		return
	}
	defer root.Close()
	file := fs.Read(root, path)
	file.RequestID = id
	a.client.Send(protocol.NewFsFileFrame(file))
}

func fsFailedDir(dir protocol.FsDir, err error) protocol.FsDir {
	message := err.Error()
	dir.Error = &message
	return dir
}

func fsFailedFile(file protocol.FsFile, err error) protocol.FsFile {
	message := err.Error()
	file.Error = &message
	return file
}

func fsFailedChunk(chunk protocol.FsChunk, err error) protocol.FsChunk {
	message := err.Error()
	chunk.Error = &message
	return chunk
}

func fsFailedWrote(wrote protocol.FsWrote, err error) protocol.FsWrote {
	message := err.Error()
	wrote.Error = &message
	return wrote
}

func fsFailedRemoved(removed protocol.FsRemoved, err error) protocol.FsRemoved {
	message := err.Error()
	removed.Error = &message
	return removed
}

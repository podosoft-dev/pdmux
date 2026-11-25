package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/podosoft-dev/pdmux/agent/internal/semver"
)

// An engine never gives up a running program, so an update cannot replace an
// engine that still has sessions. Instead the newer engine starts beside it:
//
//   - Root is where an engine normally serves. Agents of any version find it there.
//   - Root/slots/<id> holds a newer engine while an older one in Root still runs
//     programs. A slot is used once; the engine that starts next after it
//     stopped removes it.
//
// The client treats the engines as one: lists are merged, a session is reached
// in the engine that has it, and a new session starts in the newest engine.
// Older engines take no new sessions and stop on their own once idle.

const slotsDirectory = "slots"

var slotName = regexp.MustCompile(`^[0-9a-f]{24}$`)

// engineDirs lists Root and every slot directory, Root first.
func engineDirs(root string) []string {
	dirs := []string{root}
	entries, err := os.ReadDir(filepath.Join(root, slotsDirectory))
	if err != nil {
		return dirs
	}
	for _, entry := range entries {
		if entry.IsDir() && slotName.MatchString(entry.Name()) {
			dirs = append(dirs, filepath.Join(root, slotsDirectory, entry.Name()))
		}
	}
	return dirs
}

// engineBase is the Root an engine directory belongs to.
func engineBase(dir string) string {
	parent := filepath.Dir(dir)
	if filepath.Base(parent) == slotsDirectory && slotName.MatchString(filepath.Base(dir)) {
		return filepath.Dir(parent)
	}
	return dir
}

func newSlot(root string) (string, error) {
	if err := secureDirectory(filepath.Join(root, slotsDirectory)); err != nil {
		return "", err
	}
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return filepath.Join(root, slotsDirectory, hex.EncodeToString(id[:])), nil
}

// newerVersion reports whether a is a newer engine version than b.
func newerVersion(a, b string) bool {
	order, valid := semver.CompareStrings(a, b)
	return valid && order > 0
}

type runningEngine struct {
	dir     string
	version string
}

// skippable is an engine directory that does not answer: nothing serves there,
// or, for a slot, anything else that keeps it from answering. Root's other
// errors are reported, as they were when Root was the only engine.
func (c *Client) skippable(dir string, err error) bool {
	return err.Error() == "SESSION_ENGINE_NOT_RUNNING" || dir != c.Root
}

func (c *Client) running(ctx context.Context) ([]runningEngine, error) {
	var engines []runningEngine
	for _, dir := range engineDirs(c.Root) {
		reply, err := c.requestAt(ctx, dir, Request{Action: "ping"})
		if err != nil {
			if c.skippable(dir, err) {
				continue
			}
			return nil, err
		}
		engines = append(engines, runningEngine{dir: dir, version: reply.Version})
	}
	return engines, nil
}

type engineList struct {
	dir   string
	reply Reply
}

// lists asks every engine for its sessions, Root's shown by catalog name.
func (c *Client) lists(ctx context.Context) ([]engineList, error) {
	var lists []engineList
	for _, dir := range engineDirs(c.Root) {
		reply, err := c.requestAt(ctx, dir, Request{Action: "list"})
		if err != nil {
			if c.skippable(dir, err) {
				continue
			}
			return nil, err
		}
		if dir == c.Root {
			if err := c.applyNames(&reply); err != nil {
				return nil, err
			}
		}
		lists = append(lists, engineList{dir: dir, reply: reply})
	}
	return lists, nil
}

func (c *Client) Request(ctx context.Context, r Request) (Reply, error) {
	switch r.Action {
	case "list":
		return c.listAll(ctx)
	case "ping":
		return c.pingNewest(ctx)
	case "shutdown":
		return c.shutdownAll(ctx)
	case "rename":
		return c.rename(ctx, r)
	case "history", "terminate":
		dir, err := c.owner(ctx, r.ID)
		if err != nil {
			return Reply{}, err
		}
		reply, err := c.requestAt(ctx, dir, r)
		if err == nil && dir == c.Root {
			err = c.applyNames(&reply)
		}
		return reply, err
	}
	reply, err := c.request(ctx, r)
	if err == nil {
		err = c.applyNames(&reply)
	}
	return reply, err
}

func (c *Client) listAll(ctx context.Context) (Reply, error) {
	lists, err := c.lists(ctx)
	if err != nil {
		return Reply{}, err
	}
	if len(lists) == 0 {
		return Reply{}, fmt.Errorf("SESSION_ENGINE_NOT_RUNNING")
	}
	merged := Reply{Protocol: Protocol, Type: "result"}
	seen := make(map[string]bool)
	for _, list := range lists {
		if merged.Version == "" || newerVersion(list.reply.Version, merged.Version) {
			merged.Version = list.reply.Version
		}
		for _, info := range list.reply.Sessions {
			if !seen[info.ID] {
				seen[info.ID] = true
				merged.Sessions = append(merged.Sessions, info)
			}
		}
	}
	sort.SliceStable(merged.Sessions, func(i, j int) bool {
		if merged.Sessions[i].Name != merged.Sessions[j].Name {
			return merged.Sessions[i].Name < merged.Sessions[j].Name
		}
		return merged.Sessions[i].ID < merged.Sessions[j].ID
	})
	return merged, nil
}

// pingNewest answers for the newest running engine.
func (c *Client) pingNewest(ctx context.Context) (Reply, error) {
	engines, err := c.running(ctx)
	if err != nil {
		return Reply{}, err
	}
	if len(engines) == 0 {
		return Reply{}, fmt.Errorf("SESSION_ENGINE_NOT_RUNNING")
	}
	newest := engines[0]
	for _, e := range engines[1:] {
		if newerVersion(e.version, newest.version) {
			newest = e
		}
	}
	return Reply{Protocol: Protocol, Type: "result", Version: newest.version}, nil
}

// shutdownAll stops every idle engine and reports SESSION_ENGINE_BUSY while any
// engine still runs programs.
func (c *Client) shutdownAll(ctx context.Context) (Reply, error) {
	engines, err := c.running(ctx)
	if err != nil {
		return Reply{}, err
	}
	if len(engines) == 0 {
		return Reply{}, fmt.Errorf("SESSION_ENGINE_NOT_RUNNING")
	}
	var reply Reply
	var busy error
	for _, e := range engines {
		answer, err := c.requestAt(ctx, e.dir, Request{Action: "shutdown"})
		if err != nil {
			if err.Error() != "SESSION_ENGINE_BUSY" {
				return Reply{}, err
			}
			busy = err
			continue
		}
		reply = answer
	}
	return reply, busy
}

// owner is the directory of the engine running session id.
func (c *Client) owner(ctx context.Context, id string) (string, error) {
	lists, err := c.lists(ctx)
	if err != nil {
		return "", err
	}
	if len(lists) == 0 {
		return "", fmt.Errorf("SESSION_ENGINE_NOT_RUNNING")
	}
	for _, list := range lists {
		for _, info := range list.reply.Sessions {
			if info.ID == id {
				return list.dir, nil
			}
		}
	}
	return "", fmt.Errorf("SESSION_NOT_FOUND")
}

// rename keeps names unique across engines: each engine only checks its own.
func (c *Client) rename(ctx context.Context, r Request) (Reply, error) {
	unlock, err := c.lockClient(ctx, "session-names.lock")
	if err != nil {
		return Reply{}, err
	}
	defer unlock()
	lists, err := c.lists(ctx)
	if err != nil {
		return Reply{}, err
	}
	if len(lists) == 0 {
		return Reply{}, fmt.Errorf("SESSION_ENGINE_NOT_RUNNING")
	}
	owner := ""
	for _, list := range lists {
		for _, info := range list.reply.Sessions {
			if info.ID == r.ID {
				owner = list.dir
			} else if info.Name == r.Name {
				return Reply{}, fmt.Errorf("SESSION_EXISTS")
			}
		}
	}
	if owner == "" {
		return Reply{}, fmt.Errorf("SESSION_NOT_FOUND")
	}
	reply, err := c.requestAt(ctx, owner, r)
	if owner != c.Root {
		return reply, err
	}
	if err != nil && err.Error() == "INVALID_SESSION_ACTION" {
		return c.renameLegacy(ctx, r)
	}
	if err == nil {
		err = c.applyNames(&reply)
	}
	return reply, err
}

func (c *Client) Attach(ctx context.Context, request Request) (*Attachment, error) {
	current, err := c.ensure(ctx)
	if err != nil {
		return nil, err
	}
	if request.ID != "" {
		return c.attachID(ctx, current, request)
	}
	return c.attachName(ctx, current, request)
}

// attachID reaches a session by its immutable ID in the engine running it. An
// ID nothing runs may be a session a restart ended: the engine that recorded it
// reopens it, so each engine is asked in turn, the current one first.
func (c *Client) attachID(ctx context.Context, current string, r Request) (*Attachment, error) {
	lists, err := c.lists(ctx)
	if err != nil {
		return nil, err
	}
	order := []string{current}
	for _, list := range lists {
		for _, info := range list.reply.Sessions {
			if info.ID == r.ID {
				return c.attachWithNames(ctx, list.dir, r)
			}
		}
		if list.dir != current {
			order = append(order, list.dir)
		}
	}
	for _, dir := range order {
		attachment, err := c.attachWithNames(ctx, dir, r)
		if err == nil || err.Error() != "SESSION_NOT_FOUND" {
			return attachment, err
		}
	}
	return nil, fmt.Errorf("SESSION_NOT_FOUND")
}

// attachName resolves a visible name across every engine, so one name never
// means two programs. A name no engine has starts in the current engine.
func (c *Client) attachName(ctx context.Context, current string, r Request) (*Attachment, error) {
	unlock, err := c.lockClient(ctx, "session-names.lock")
	if err != nil {
		return nil, err
	}
	defer unlock()
	lists, err := c.lists(ctx)
	if err != nil {
		return nil, err
	}
	for _, list := range lists {
		for _, info := range list.reply.Sessions {
			if info.Name != r.Name {
				continue
			}
			if r.Action == "create" {
				return nil, fmt.Errorf("SESSION_EXISTS")
			}
			r.ID, r.Action = info.ID, "attach"
			return c.attachWithNames(ctx, list.dir, r)
		}
	}
	if r.Action == "attach" {
		return nil, fmt.Errorf("SESSION_NOT_FOUND")
	}
	if current == c.Root {
		return c.createInRoot(ctx, r)
	}
	return c.attachAt(ctx, current, r)
}

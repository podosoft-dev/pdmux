package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Legacy helpers keep owning their PTYs. A generation-scoped name catalog lets
// updated clients rename those programs without restarting the old helper.
type sessionNames struct {
	Generation string            `json:"generation"`
	Names      map[string]string `json:"names"`
}

func (c *Client) names() (sessionNames, error) {
	result := sessionNames{Names: make(map[string]string)}
	bytes, err := os.ReadFile(filepath.Join(c.Root, "session-names.json"))
	if os.IsNotExist(err) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if len(bytes) > 16<<10 || json.Unmarshal(bytes, &result) != nil || len(result.Names) > MaxSessions || result.Names == nil {
		return sessionNames{}, fmt.Errorf("SESSION_NAMES_INVALID")
	}
	generation, err := c.generation()
	if err != nil {
		return result, err
	}
	if result.Generation != generation {
		return sessionNames{Names: make(map[string]string)}, nil
	}
	for _, name := range result.Names {
		if !validName.MatchString(name) {
			return sessionNames{}, fmt.Errorf("SESSION_NAMES_INVALID")
		}
	}
	return result, nil
}

func (c *Client) generation() (string, error) {
	bytes, err := os.ReadFile(filepath.Join(c.Root, "endpoint.json"))
	if err != nil {
		return "", err
	}
	var metadata endpoint
	if json.Unmarshal(bytes, &metadata) != nil || len(metadata.Secret) != 64 {
		return "", fmt.Errorf("SESSION_ENGINE_METADATA_INVALID")
	}
	digest := sha256.Sum256([]byte(metadata.Secret))
	return hex.EncodeToString(digest[:]), nil
}

func overlayNames(reply *Reply, names sessionNames) {
	apply := func(info *Info) {
		if name := names.Names[info.ID]; name != "" {
			info.Name = name
		}
	}
	if reply.Info != nil {
		apply(reply.Info)
	}
	for i := range reply.Sessions {
		apply(&reply.Sessions[i])
	}
	sort.Slice(reply.Sessions, func(i, j int) bool { return reply.Sessions[i].Name < reply.Sessions[j].Name })
}

func (c *Client) applyNames(reply *Reply) error {
	if reply.Info == nil && len(reply.Sessions) == 0 {
		return nil
	}
	names, err := c.names()
	if err == nil {
		overlayNames(reply, names)
	}
	return err
}

func (c *Client) lockClient(ctx context.Context, name string) (func(), error) {
	if err := secureDirectory(c.Root); err != nil {
		return nil, err
	}
	for {
		unlock, err := lockFile(c.Root, name)
		if err == nil {
			return unlock, nil
		}
		if err.Error() != "SESSION_ENGINE_ALREADY_RUNNING" {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (c *Client) saveNames(names sessionNames, active []Info) error {
	generation, err := c.generation()
	if err != nil {
		return err
	}
	if names.Generation != "" && names.Generation != generation {
		return fmt.Errorf("SESSION_CONNECTION_LOST")
	}
	names.Generation = generation
	live := make(map[string]string)
	for _, info := range active {
		if name := names.Names[info.ID]; name != "" {
			live[info.ID] = name
		}
	}
	names.Names = live
	file, err := os.CreateTemp(c.Root, ".session-names-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if err := secureFile(file.Name()); err != nil {
		return err
	}
	if err := json.NewEncoder(file).Encode(names); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), filepath.Join(c.Root, "session-names.json"))
}

func (c *Client) renameLegacy(ctx context.Context, r Request) (Reply, error) {
	if !validName.MatchString(r.Name) {
		return Reply{}, fmt.Errorf("INVALID_SESSION_NAME")
	}
	unlock, err := c.lockClient(ctx, "session-names.lock")
	if err != nil {
		return Reply{}, err
	}
	defer unlock()
	list, err := c.request(ctx, Request{Action: "list"})
	if err != nil {
		return Reply{}, err
	}
	names, err := c.names()
	if err != nil {
		return Reply{}, err
	}
	overlayNames(&list, names)
	var target *Info
	for i := range list.Sessions {
		info := &list.Sessions[i]
		if info.ID == r.ID {
			target = info
		}
		if info.ID != r.ID && info.Name == r.Name {
			return Reply{}, fmt.Errorf("SESSION_EXISTS")
		}
	}
	if target == nil {
		return Reply{}, fmt.Errorf("SESSION_NOT_FOUND")
	}
	names.Names[r.ID] = r.Name
	if err := c.saveNames(names, list.Sessions); err != nil {
		return Reply{}, err
	}
	target.Name = r.Name
	return Reply{Protocol: Protocol, Type: "result", Version: list.Version, Info: target}, nil
}

func (c *Client) attachNamed(ctx context.Context, r Request) (*Attachment, error) {
	// Immutable IDs need no name lookup and cannot select a different program.
	if r.ID != "" {
		return c.attachWithNames(ctx, r)
	}
	unlock, err := c.lockClient(ctx, "session-names.lock")
	if err != nil {
		return nil, err
	}
	defer unlock()
	names, err := c.names()
	if err != nil {
		return nil, err
	}
	if len(names.Names) == 0 {
		return c.attach(ctx, r)
	}
	if !validName.MatchString(r.Name) {
		return nil, fmt.Errorf("INVALID_SESSION_NAME")
	}
	raw, err := c.request(ctx, Request{Action: "list"})
	if err != nil {
		return nil, err
	}
	effective := Reply{Sessions: append([]Info(nil), raw.Sessions...)}
	overlayNames(&effective, names)
	for _, info := range effective.Sessions {
		if info.Name != r.Name {
			continue
		}
		if r.Action == "create" {
			return nil, fmt.Errorf("SESSION_EXISTS")
		}
		r.ID, r.Action = info.ID, "attach"
		return c.attachWithNames(ctx, r)
	}
	if r.Action == "attach" {
		return nil, fmt.Errorf("SESSION_NOT_FOUND")
	}
	visible := r.Name
	for _, info := range raw.Sessions {
		if info.Name == r.Name {
			r.Name = "pdmux_" + strings.ReplaceAll(randomID(), "-", "")[:24]
			break
		}
	}
	attachment, err := c.attach(ctx, r)
	if err != nil {
		return nil, err
	}
	if visible != r.Name {
		names.Names[attachment.Info.ID] = visible
		if err := c.saveNames(names, append(raw.Sessions, attachment.Info)); err != nil {
			attachment.Close()
			_, _ = c.request(ctx, Request{Action: "terminate", ID: attachment.Info.ID})
			return nil, err
		}
	}
	attachment.Info.Name = visible
	return attachment, nil
}

func (c *Client) attachWithNames(ctx context.Context, r Request) (*Attachment, error) {
	attachment, err := c.attach(ctx, r)
	if err != nil {
		return nil, err
	}
	reply := Reply{Info: &attachment.Info}
	if err := c.applyNames(&reply); err != nil {
		attachment.Close()
		return nil, err
	}
	return attachment, nil
}

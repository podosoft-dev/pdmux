package session

import (
	"crypto/sha256"
	"fmt"
	"path/filepath"

	"github.com/podosoft-dev/pdmux/agent/internal/config"
	"github.com/podosoft-dev/pdmux/agent/internal/state"
)

func LocalClient(configPath, executable string) *Client {
	root := state.ResolveDir(state.DirInput{Env: config.OSEnv()})
	identity := "default"
	if configPath != "" {
		absolute, _ := filepath.Abs(configPath)
		hash := sha256.Sum256([]byte(absolute))
		identity = fmt.Sprintf("%x", hash[:12])
	}
	return &Client{Root: filepath.Join(root, "sessions", identity), Executable: executable}
}

package usage

// Composing a cheap provider with an expensive one.
//
// The transcript reader answers for nothing on a host where the CLI has run.
// It cannot answer on a host where transcripts are off or the CLI has never
// been used, and on those hosts the only way to get the number is still to ask
// the CLI itself.
//
// ⚠ ORDER IS THE WHOLE POINT. The expensive provider is consulted ONLY when the
// cheap one came back empty, so the normal case pays nothing and the unusual
// case keeps working instead of silently reporting "no budget". Reversing them,
// or asking both, would give back exactly the cost this exists to remove.

import (
	"context"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// FirstAnswering tries providers in order and returns the first non-empty answer.
type FirstAnswering struct {
	id        string
	providers []Provider
}

// NewFirstAnswering composes providers, cheapest first.
func NewFirstAnswering(id string, providers ...Provider) *FirstAnswering {
	return &FirstAnswering{id: id, providers: providers}
}

// ID is the provider id, echoed to the server as-is.
func (p *FirstAnswering) ID() string { return p.id }

// ProcessCount comes from the FIRST provider only.
//
// Counting is already cheap and every member counts the same binary, so asking
// more than one would just run the same `pgrep` twice.
func (p *FirstAnswering) ProcessCount(ctx context.Context) int {
	for _, provider := range p.providers {
		return provider.ProcessCount(ctx)
	}
	return 0
}

// Windows returns the first non-empty answer.
func (p *FirstAnswering) Windows(ctx context.Context) []protocol.UsageWindow {
	for _, provider := range p.providers {
		if windows := provider.Windows(ctx); len(windows) > 0 {
			return windows
		}
	}
	return []protocol.UsageWindow{}
}

// Paths reports where every member looks, so the "running but silent" log line
// names all of them rather than only the one that happened to be asked last.
func (p *FirstAnswering) Paths() []string {
	out := []string{}
	for _, provider := range p.providers {
		if reporter, ok := provider.(interface{ Paths() []string }); ok {
			out = append(out, reporter.Paths()...)
		}
	}
	return out
}

package agent

import (
	"encoding/json"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
	"github.com/podosoft-dev/pdmux/agent/internal/sys"
)

func TestHelloBootID(t *testing.T) {
	t.Run("[TC-PDAGENT-132] hello reports the host's boot identity and still passes the contract", func(t *testing.T) {
		hello := BuildHello("test-host", "9.9.9", "https://pdmux.example", protocol.NewAgentUpdateAbility())
		want := sys.BootID()
		switch {
		case want == "" && hello.BootID != nil:
			t.Fatalf("BootID = %q on a host without one, want the key omitted", *hello.BootID)
		case want != "" && (hello.BootID == nil || *hello.BootID != want):
			t.Fatalf("BootID = %v, want %q", hello.BootID, want)
		}
		raw, err := json.Marshal(&protocol.HelloFrame{Type: protocol.UpstreamHello, Hello: hello})
		if err != nil {
			t.Fatal(err)
		}
		if err := protocol.ValidateUpstream(raw); err != nil {
			t.Fatalf("hello with a boot identity no longer validates: %v", err)
		}
	})
}

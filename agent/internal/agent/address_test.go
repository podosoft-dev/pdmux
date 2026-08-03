package agent

import (
	"encoding/json"
	"net"
	"strings"
	"testing"

	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

// The host answers where it can be reached, because the server cannot.
//
// What a server observes is the far end of a socket, and the agent dials OUT.
// Measured on one deployment: one agent arrived as `127.0.0.1` (it is the same
// machine as the server) and another as `172.22.0.2`, a container-bridge address
// belonging to the reverse proxy. Neither is a way back to the machine. The host
// itself can simply ask its kernel which source address reaches the server.

func TestPrimaryAddress(t *testing.T) {
	t.Run("[TC-PDAGENT-106] answers with a routable address, never loopback", func(t *testing.T) {
		got := PrimaryAddress("https://pdmux.example:443")
		if got == "" {
			// ⚠ Not a get-out: a build machine with no network is a real case, and an
			// empty string is the contract's own default for it. The frame subtest below
			// still runs, so the wire shape is covered either way.
			t.Skip("no routable interface on this machine; empty is the documented answer")
		}
		ip := net.ParseIP(got)
		if ip == nil {
			t.Fatalf("PrimaryAddress() = %q, which is not an IP", got)
		}
		// The whole point. Every machine calls itself 127.0.0.1, which is the answer
		// this field exists to replace.
		if ip.IsLoopback() {
			t.Fatalf("PrimaryAddress() = %q, the one answer this field exists to replace", got)
		}
		if ip.IsLinkLocalUnicast() {
			t.Fatalf("PrimaryAddress() = %q — unusable without a zone index", got)
		}
	})

	t.Run("[TC-PDAGENT-106] a server on THIS machine still yields a routable answer", func(t *testing.T) {
		/**
		 * ⚠ THE CASE THAT STARTED THIS, and the one a public server URL never reaches.
		 * When the dashboard runs on the host itself the kernel's honest answer is
		 * `127.0.0.1` — true, and exactly the value this field exists to replace. The
		 * interfaces have to be consulted instead.
		 *
		 * Written after reverting the guard and watching the earlier test pass anyway:
		 * dialling a PUBLIC name picks the public route, so the loopback branch was
		 * never executed and nothing was proving it worked.
		 */
		if firstRoutableInterface() == "" {
			t.Skip("no routable interface on this machine; nothing better than loopback exists")
		}
		got := PrimaryAddress("http://127.0.0.1:5002")
		if got == "" {
			t.Fatal("PrimaryAddress() gave up on a local server, but this machine has a routable interface")
		}
		if ip := net.ParseIP(got); ip == nil || ip.IsLoopback() {
			t.Fatalf("PrimaryAddress(local server) = %q, want the machine's own routable address", got)
		}
	})

	t.Run("[TC-PDAGENT-106] a server URL it cannot use does not cost the host its address", func(t *testing.T) {
		// The interfaces are still there to be read, and `hello` still has to go out.
		for _, serverURL := range []string{"", "   ", "not a url", "://missing-scheme", "https://"} {
			got := PrimaryAddress(serverURL)
			if got == "" {
				continue // no network on this machine — covered above
			}
			if ip := net.ParseIP(got); ip == nil || ip.IsLoopback() {
				t.Fatalf("PrimaryAddress(%q) = %q, want a routable address or empty", serverURL, got)
			}
		}
	})

	t.Run("[TC-PDAGENT-106] the dial target stays parseable", func(t *testing.T) {
		// Nothing is sent, but `net.Dial` still refuses an address it cannot parse, and
		// a refusal here would silently cost every host its address.
		cases := map[string]string{
			"https://pdmux.example":            "pdmux.example:443",
			"wss://pdmux.example":              "pdmux.example:443",
			"http://pdmux.example":             "pdmux.example:80",
			"ws://pdmux.example":               "pdmux.example:80",
			"https://pdmux.example:8443/agent": "pdmux.example:8443",
			"http://10.0.0.5:5002":             "10.0.0.5:5002",
			"https://[2001:db8::1]:443":        "[2001:db8::1]:443",
			"":                                 "",
			"not a url":                        "",
		}
		for in, want := range cases {
			if got := serverHostPort(in); got != want {
				t.Fatalf("serverHostPort(%q) = %q, want %q", in, got, want)
			}
		}
	})

	t.Run("[TC-PDAGENT-106] hello carries it and still passes the contract", func(t *testing.T) {
		// ⚠ NewAgentUpdateAbility, not a struct literal. A literal leaves restartMode as
		// "" where the contract says "none" — the exact trap the generator exists to
		// avoid, and it fails validation, as this test found out when it was written.
		hello := BuildHello("test-host", "9.9.9", "https://pdmux.example", protocol.NewAgentUpdateAbility())
		if hello.Hostname != "test-host" || hello.AgentVersion != "9.9.9" {
			t.Fatalf("BuildHello lost its basics: %+v", hello)
		}
		// ⚠ VALIDATED ON THE WIRE IT ACTUALLY TRAVELS. A `hello` that fails validation
		// never reaches the registry and the host disappears from the dashboard — which
		// is why the new key carries a default, and why this is checked not assumed.
		raw, err := json.Marshal(&protocol.HelloFrame{Type: protocol.UpstreamHello, Hello: hello})
		if err != nil {
			t.Fatalf("marshal hello: %v", err)
		}
		if err := protocol.ValidateUpstream(raw); err != nil {
			t.Fatalf("hello with an address no longer validates: %v", err)
		}
		if strings.TrimSpace(hello.Address) != hello.Address {
			t.Fatalf("Address = %q, want no surrounding space", hello.Address)
		}
		if ip := net.ParseIP(hello.Address); hello.Address != "" && (ip == nil || ip.IsLoopback()) {
			t.Fatalf("Address = %q, want a routable address or empty", hello.Address)
		}
		// ⚠ AND IT ACTUALLY CARRIES WHAT WAS FOUND. Asserting only "routable or empty"
		// passes just as happily against `hello.Address = ""` — measured, by reverting
		// exactly that. Tying it to the discovery is what makes the assertion bite.
		if want := PrimaryAddress("https://pdmux.example"); hello.Address != want {
			t.Fatalf("Address = %q, want the discovered %q — hello is not reporting it", hello.Address, want)
		}
	})
}

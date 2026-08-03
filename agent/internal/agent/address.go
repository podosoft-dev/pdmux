package agent

import (
	"net"
	"net/url"
	"strings"
)

// Where this host can be reached — asked of the kernel, not of the server.
//
// ⚠ THE SERVER CANNOT ANSWER THIS, and that is the whole reason the question is
// asked here. A server sees the far end of a socket, and the agent dials OUT:
// measured on one deployment, one agent arrived as `127.0.0.1` (it is the same
// machine as the server) and another as `172.22.0.2`, a container-bridge address
// belonging to the reverse proxy in front of it. Neither is a way back to the
// machine, and neither is wrong — they are simply what "the other end of this
// socket" means once anything sits in the path.
//
// The host itself has the answer, and it does not need to guess: the kernel
// already picks a source address for every outbound connection, and the one it
// picks for the SERVER is by definition an address on the route between the two.
// That is the closest thing to "reachable" any single value can be.
//
// WHAT IT IS NOT: proof that the dashboard's browser can open it. A machine
// behind NAT reports its LAN address, which is right for everyone on that LAN
// and useless from outside it. Nothing the agent can measure changes that — a
// public entry point is a fact about the network, not about the host — so this
// reports what it knows and the operator's own `address` still wins where they
// have set one.

// PrimaryAddress returns the local address that reaches serverURL, or "".
//
// `net.Dial` on UDP performs no handshake and sends no packet: it only asks the
// kernel to bind a socket, which forces the routing decision and reveals the
// source address. So this costs no traffic, cannot be refused by a firewall and
// cannot block on an unreachable peer — the three reasons a TCP probe would be
// the wrong instrument.
func PrimaryAddress(serverURL string) string {
	if host := dialSource(serverHostPort(serverURL)); host != "" {
		return host
	}
	// No usable server URL, or a kernel that would not route to it (a laptop with
	// the network down still deserves to report where it lives). Fall back to the
	// interfaces themselves.
	return firstRoutableInterface()
}

// serverHostPort turns the configured server URL into a dial target.
func serverHostPort(serverURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(serverURL))
	if err != nil || parsed.Host == "" {
		return ""
	}
	host := parsed.Hostname()
	if host == "" {
		return ""
	}
	// The port is immaterial to a routing decision — nothing is sent — but it has
	// to be present and plausible for `Dial` to accept the address at all.
	port := parsed.Port()
	if port == "" {
		if parsed.Scheme == "https" || parsed.Scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return net.JoinHostPort(host, port)
}

func dialSource(target string) string {
	if target == "" {
		return ""
	}
	conn, err := net.Dial("udp", target)
	if err != nil {
		return ""
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP == nil {
		return ""
	}
	// A loopback source means the server IS this machine. That is true and it is
	// also the value this whole field exists to stop reporting, so say nothing
	// rather than say `127.0.0.1` — the interfaces below may know better.
	if addr.IP.IsLoopback() {
		return firstRoutableInterface()
	}
	return addr.IP.String()
}

// firstRoutableInterface picks an address off the interfaces directly.
//
// Ordering is by how much use the address is to somebody trying to reach this
// host: a global IPv4 first (what almost every operator means), then a global
// IPv6, and link-local never — `fe80::…` is unusable without the zone index and
// carrying that into a dashboard cell helps nobody.
func firstRoutableInterface() string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var v6 string
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP == nil {
				continue
			}
			ip := ipNet.IP
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
				continue
			}
			if v4 := ip.To4(); v4 != nil {
				return v4.String()
			}
			if v6 == "" {
				v6 = ip.String()
			}
		}
	}
	return v6
}

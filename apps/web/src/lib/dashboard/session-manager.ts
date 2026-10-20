import type { TerminalSlot } from "@pdmux/core";
import type { HostView } from "./types";

export interface ManagedSession {
  key: string;
  hostId: string;
  hostName: string;
  name: string;
  backend: "native" | "tmux";
  attached: number;
  online: boolean;
  slot: TerminalSlot;
}

/** One row per host/backend/identity, including sessions with no dashboard pane. */
export function managedSessions(hosts: readonly HostView[], search = ""): ManagedSession[] {
  const query = search.trim().toLocaleLowerCase();
  return hosts.flatMap(host => (host.sessions ?? []).map(session => {
    const backend = session.backend ?? "tmux";
    const key = `${host.id}:${backend}:${session.sessionId ?? session.tmuxId ?? session.name}`;
    return {
      key, hostId: host.id, hostName: host.label, name: session.name, backend,
      attached: session.attached ?? 0,
      online: host.enabled && host.online && host.connected && host.origin?.readOnly !== true,
      slot: { id: key, hostId: host.id, kind: "attach" as const, session: session.name, backend, ...(session.sessionId ? { sessionId: session.sessionId } : {}), ...(session.tmuxId ? { tmuxId: session.tmuxId } : {}) },
    };
  })).filter(row => !query || `${row.hostName} ${row.name}`.toLocaleLowerCase().includes(query));
}

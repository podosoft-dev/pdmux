import type { MuxSession } from "@pdmux/protocol";

/** A tmux session as the host view reports it, with the names pdmux renamed it from. */
export type HostSession = MuxSession & { previousNames?: string[] };

/** What a pdmux tmux rename publishes, so every API replica learns it. */
export interface SessionRenamedEvent {
  type: "host.session-renamed";
  hostId: string;
  tmuxId: string;
  from: string;
  to: string;
}

const TMUX_ID = /^\$[0-9]{1,16}$/;
/** Names kept per session: enough for a few renames in a row, small enough to ship in every view. */
const MAX_PREVIOUS = 8;
/** Sessions tracked per host; the oldest is dropped first. */
const MAX_SESSIONS = 64;

export function isSessionRenamedEvent(event: unknown): event is SessionRenamedEvent {
  if (typeof event !== "object" || event === null) return false;
  const value = event as Record<string, unknown>;
  return value.type === "host.session-renamed"
    && typeof value.hostId === "string"
    && typeof value.tmuxId === "string" && TMUX_ID.test(value.tmuxId)
    && typeof value.from === "string" && value.from.length > 0
    && typeof value.to === "string" && value.to.length > 0;
}

/**
 * The tmux renames made through pdmux, so another window can follow them.
 *
 * A saved tmux pane names its session by id AND name, and never follows a live session
 * whose id matches but whose name differs: tmux numbers sessions from `$0` per server,
 * so after a restart the same id is somebody else's session. That rule also stopped a
 * rename made in one window from reaching the other windows showing the session — they
 * saw the same id under a new name and could not tell a rename from a reuse.
 *
 * pdmux knows which it was when the rename went through it, so it records it here:
 * the session id, the name it has now, and the names it had before. The host view
 * reports those previous names on the live session, and a pane follows a new name only
 * when its saved name is one of them. A record holds only while the host still reports
 * that id under the new name, or under an old one while the heartbeat that shows the
 * rename is on its way. Once the session ends or is renamed outside pdmux, the record
 * goes, so a reused id never inherits it, and an agent reconnect (a restart that may
 * have taken the tmux server with it) drops every record for the host.
 *
 * In memory per API replica. Replicas learn renames through the host event bus. A
 * restart forgets them, and then a window that still has the old name reopens as the
 * pane did before this existed.
 */
export class SessionRenames {
  private readonly byHost = new Map<string, Map<string, { name: string; previous: string[] }>>();

  record(event: SessionRenamedEvent): void {
    if (event.from === event.to) return;
    const sessions = this.byHost.get(event.hostId) ?? new Map<string, { name: string; previous: string[] }>();
    const known = sessions.get(event.tmuxId);
    // Idempotent: the replica that made the rename records it and then hears it again.
    if (known?.name === event.to) return;
    const earlier = known && known.name === event.from ? known.previous : [];
    const previous = [...earlier.filter((name) => name !== event.to && name !== event.from), event.from].slice(-MAX_PREVIOUS);
    sessions.delete(event.tmuxId);
    sessions.set(event.tmuxId, { name: event.to, previous });
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    this.byHost.set(event.hostId, sessions);
  }

  /** The host's agent reconnected: its tmux server may be a new one. */
  forget(hostId: string): void {
    this.byHost.delete(hostId);
  }

  /** The live sessions, with the names pdmux renamed each from; drops records the host no longer bears out. */
  annotate(hostId: string, sessions: readonly MuxSession[]): HostSession[] {
    const records = this.byHost.get(hostId);
    if (!records || records.size === 0) return [...sessions];
    const live = new Map<string, string>();
    for (const session of sessions) {
      if (session.backend !== "native" && session.tmuxId) live.set(session.tmuxId, session.name);
    }
    for (const [tmuxId, record] of records) {
      const name = live.get(tmuxId);
      // An old name is the heartbeat from before the rename, which is still on its way.
      if (name === undefined || (name !== record.name && !record.previous.includes(name))) records.delete(tmuxId);
    }
    if (records.size === 0) this.byHost.delete(hostId);
    return sessions.map((session) => {
      const record = session.backend !== "native" && session.tmuxId ? records.get(session.tmuxId) : undefined;
      // Only the session under its new name carries the names it had: a heartbeat that
      // still shows an old name has nothing to be followed to yet.
      return record && record.name === session.name ? { ...session, previousNames: [...record.previous] } : session;
    });
  }
}

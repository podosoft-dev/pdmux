/**
 * A native pane whose session is gone, from the app's side: the wording it ships and the path
 * a click takes to a saved layout.
 *
 * The pane (`@pdmux/ui`) owns the button; the app owns the words and the save. The save is the
 * existing `onSessionResolved` → `adoptNativeSession` path both the dashboard and the detached
 * window already use, so this follows a click from the relay to the cached layout.
 */
import { describe, expect, it } from "vitest";
import { type TerminalLayout, type TerminalSlot, adoptNativeSession, defaultLayout, missingSessionTarget, normalizeLayout } from "@pdmux/core";
import english from "../src/lib/i18n/catalogs/app/en.json";
import korean from "../src/lib/i18n/catalogs/app/ko.json";
import { readCachedLayout, writeCachedLayout, type LayoutStorage } from "$lib/dashboard/layout-store";
import { TerminalRelay, type RelaySocket } from "$lib/dashboard/terminal-relay";
import { uiTranslate } from "$lib/dashboard/ui-i18n";

const GONE = "d5ac0000-0000-4000-8000-000000000001";
const FRESH = "d5ac0000-0000-4000-8000-000000000002";

describe("[TC-PDWEB-057] the reopen offer is worded in both languages", () => {
  it("names the session, says its programs are gone, and labels the button", () => {
    const ko = uiTranslate(korean);
    const en = uiTranslate(english);
    expect(ko("pdmux.pane.missingReopen", "")).toBe("같은 이름으로 새 세션 열기");
    expect(en("pdmux.pane.missingReopen", "")).toBe("Open a new session with the same name");
    for (const translate of [ko, en]) expect(translate("pdmux.pane.missingSession", "")).toContain("{name}");
    expect(ko("pdmux.pane.missingSession", "")).toContain("사라졌습니다");
    expect(en("pdmux.pane.missingSession", "")).toContain("are gone");
  });
});

class Socket implements RelaySocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  accept(): void { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  opens(): Array<{ termId: string; target: Record<string, unknown> }> {
    return this.sent.map((line) => JSON.parse(line) as { type: string; termId: string; target: Record<string, unknown> }).filter((frame) => frame.type === "open");
  }
}

describe("[TC-PDWEB-058] a click on a missing native pane ends as the same slot, saved with the new session", () => {
  it("opens by name, adopts the new UUID in place and keeps it across a reload", () => {
    const sockets: Socket[] = [];
    const relay = new TerminalRelay({ url: "ws://test/terminal/ws", createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; }, schedule: () => 0, cancel: () => undefined });
    const slot: TerminalSlot = { id: "s14", hostId: "h1", kind: "attach", backend: "native", session: "w2", sessionId: GONE, intent: "attach", tags: [{ name: "prod", color: "#123456" }] };
    let layout: TerminalLayout = { ...defaultLayout(), mode: "split4", slots: [null, slot] };
    const store = new Map<string, string>();
    const storage: LayoutStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) };
    // The page's `onSessionResolved`: adopt, and save only when something changed.
    const resolved = (slotId: string, id: string): void => {
      const next = adoptNativeSession(layout, slotId, id);
      if (next !== layout) { layout = next; writeCachedLayout(storage, layout); }
    };

    const saved = relay.open({ slotId: slot.id, hostId: slot.hostId, kind: "session", session: "w2", backend: "native", sessionId: GONE, intent: "attach", cols: 80, rows: 24 });
    let missing = false;
    saved.onMissing?.(() => { missing = true; });
    sockets[0]!.accept();
    sockets[0]!.deliver({ type: "error", termId: "s14", message: "SESSION_NOT_FOUND" });
    expect(missing).toBe(true);
    expect(store.size).toBe(0);

    // The click.
    const reopened = relay.open({ slotId: slot.id, hostId: slot.hostId, ...missingSessionTarget(slot)!, cols: 80, rows: 24 });
    reopened.onSession?.((id) => resolved(slot.id, id));
    const open = sockets[0]!.opens().at(-1)!;
    expect(open.termId).toBe("s14");
    expect(open.target).toMatchObject({ session: "w2", backend: "native", intent: "ensure" });
    expect(open.target.sessionId).toBeUndefined();
    sockets[0]!.deliver({ type: "ready", termId: "s14", pid: 3, backend: "native", sessionId: FRESH });

    const reloaded = normalizeLayout(readCachedLayout(storage), [{ id: "h1", name: "alpha", online: true }]);
    expect(reloaded.slots[0]).toBeNull();
    expect(reloaded.slots[1]).toEqual({ ...slot, sessionId: FRESH, intent: "attach", backend: "native", kind: "attach" });
    relay.dispose();
  });
});

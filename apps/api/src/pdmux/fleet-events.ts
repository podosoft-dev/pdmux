import type { AuthService } from "../auth/auth.service";
import type { Unsubscribe } from "@podosoft/podokit-runtime";
import { resolveScopeId } from "../fleet/session-scope";
import type { HostsService } from "../hosts/hosts.service";
import type { HostEvents } from "./host-events";
import type { Shutdown } from "../core/shutdown";

export interface FleetEventDependencies {
  auth: Pick<AuthService, "requireSession" | "guard">;
  hosts: Pick<HostsService, "listIds">;
  events: Pick<HostEvents, "subscribe" | "onInterruption">;
  /** The stream never finishes on its own, so it ends when the API starts shutting down. */
  shutdown: Pick<Shutdown, "onShutdown">;
}

/**
 * Send bounded invalidations; host payloads still use the authorized REST view.
 * `resync` replaces `hosts.changed` after the event bus was interrupted: notices
 * published meanwhile never arrived, so the client reloads everything it shows.
 */
export async function fleetEventResponse(request: Request, dependencies: FleetEventDependencies): Promise<Response> {
  await dependencies.auth.guard(request);
  await dependencies.auth.requireSession(request);
  const encoder = new TextEncoder();
  const pending = new Set<string>();
  let closed = false;
  let busy = false;
  let resync = false;
  let lastHeartbeat = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closeStream = (): void => {};
  let stopShutdown = (): void => {};
  const unsubscribe: Unsubscribe = await dependencies.events.subscribe((event: unknown): void => {
    if (typeof event !== "object" || event === null || !("type" in event) || !("hostId" in event)) return;
    if (typeof event.type !== "string" || !event.type.startsWith("host.") || typeof event.hostId !== "string") return;
    if (pending.size < 256) pending.add(event.hostId);
  });
  const stopResync = dependencies.events.onInterruption((): void => { resync = true; });
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    stopResync();
    stopShutdown();
    void Promise.resolve(unsubscribe()).catch(() => undefined);
    pending.clear();
    request.signal.removeEventListener("abort", closeStream);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      closeStream = (): void => { cleanup(); controller.close(); };
      const send = (type: string): boolean => {
        // A slow reader gets the latest REST snapshot after reconnecting.
        if (closed || (controller.desiredSize ?? 0) <= 0) return false;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type })}\n\n`));
        return true;
      };
      const flush = async (): Promise<void> => {
        if (closed || busy || (!resync && pending.size === 0 && Date.now() - lastHeartbeat < 5_000)) return;
        busy = true;
        const changed = new Set(pending);
        pending.clear();
        try {
          // Membership and selected organization can change during a long connection.
          const fresh = new Request(request.url, { headers: request.headers });
          await dependencies.auth.guard(fresh);
          const session = await dependencies.auth.requireSession(fresh);
          if (resync) {
            // Kept until a full queue has room: it covers every change since.
            if (send("resync")) resync = false;
          } else {
            const ids = changed.size > 0 ? await dependencies.hosts.listIds(resolveScopeId(session)) : [];
            if (closed) return;
            if (ids.some(id => changed.has(id))) send("hosts.changed");
          }
          if (Date.now() - lastHeartbeat >= 5_000) {
            send("heartbeat");
            lastHeartbeat = Date.now();
          }
        } catch {
          if (!closed) closeStream();
        } finally { busy = false; }
      };
      send("ready");
      timer = setInterval(() => { void flush(); }, 250);
      request.signal.addEventListener("abort", closeStream, { once: true });
      stopShutdown = dependencies.shutdown.onShutdown(closeStream);
      if (request.signal.aborted) closeStream();
    },
    cancel(): void { cleanup(); },
  });
  return new Response(stream, { headers: {
    "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no",
  } });
}

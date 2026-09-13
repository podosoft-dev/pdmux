import type { AuthService } from "../auth/auth.service";
import type { EventsService } from "../events/events.service";
import { resolveScopeId } from "../fleet/session-scope";
import type { HostsService } from "../hosts/hosts.service";

export interface FleetEventDependencies {
  auth: Pick<AuthService, "requireSession" | "guard">;
  hosts: Pick<HostsService, "listIds">;
  events: Pick<EventsService, "subscribe">;
}

/** Send bounded invalidations; host payloads still use the authorized REST view. */
export async function fleetEventResponse(request: Request, dependencies: FleetEventDependencies): Promise<Response> {
  await dependencies.auth.guard(request);
  await dependencies.auth.requireSession(request);
  const encoder = new TextEncoder();
  const pending = new Set<string>();
  let closed = false;
  let busy = false;
  let lastHeartbeat = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = (): void => {};
  let closeStream = (): void => {};
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
    pending.clear();
    request.signal.removeEventListener("abort", closeStream);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      closeStream = (): void => { cleanup(); controller.close(); };
      const send = (type: string): void => {
        // A slow reader gets the latest REST snapshot after reconnecting.
        if (closed || (controller.desiredSize ?? 0) <= 0) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type })}\n\n`));
      };
      unsubscribe = dependencies.events.subscribe((event: unknown): void => {
        if (typeof event !== "object" || event === null || !("type" in event) || !("hostId" in event)) return;
        if (typeof event.type !== "string" || !event.type.startsWith("host.") || typeof event.hostId !== "string") return;
        if (pending.size < 256) pending.add(event.hostId);
      });
      const flush = async (): Promise<void> => {
        if (closed || busy || (pending.size === 0 && Date.now() - lastHeartbeat < 5_000)) return;
        busy = true;
        const changed = new Set(pending);
        pending.clear();
        try {
          // Membership and selected organization can change during a long connection.
          const fresh = new Request(request.url, { headers: request.headers });
          await dependencies.auth.guard(fresh);
          const session = await dependencies.auth.requireSession(fresh);
          const ids = changed.size > 0 ? await dependencies.hosts.listIds(resolveScopeId(session)) : [];
          if (closed) return;
          if (ids.some(id => changed.has(id))) send("hosts.changed");
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
      if (request.signal.aborted) closeStream();
    },
    cancel(): void { cleanup(); },
  });
  return new Response(stream, { headers: {
    "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no",
  } });
}

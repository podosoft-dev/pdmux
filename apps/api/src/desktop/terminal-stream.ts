import { AuthenticatedWebSocket } from "./authenticated-websocket";
import { AppException } from "../common/app-exception";

interface TerminalStreamOptions {
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  connectTimeoutMs?: number;
}

/** Each newline is one existing terminal protocol frame; no PTY identifiers are persisted. */
export async function terminalStream(url: string, cookie: string, input: ReadableStream<Uint8Array>, signal: AbortSignal, options: TerminalStreamOptions = {}): Promise<Response> {
  if (signal.aborted) throw new AppException("DESKTOP_TERMINAL_UNAVAILABLE", "Terminal connection was cancelled", 503);
  const socket = options.createSocket?.(url, { cookie }) ?? new AuthenticatedWebSocket(url, { headers: { cookie } });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let queued = 0;
  const output = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    pull() { queued = 0; },
    cancel() { socket.close(); },
  });
  socket.addEventListener("message", event => {
    if (typeof event.data !== "string") { socket.close(1003); return; }
    const bytes = new TextEncoder().encode(`${event.data}\n`);
    queued += bytes.length;
    if (queued > 1024 * 1024) { socket.close(1008, "slow consumer"); return; }
    try { controller.enqueue(bytes); } catch { socket.close(); }
  });
  socket.addEventListener("close", () => { try { controller.close(); } catch { /* Already cancelled. */ } });
  signal.addEventListener("abort", () => socket.close(), { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
        signal.removeEventListener("abort", failed);
      };
      const opened = (): void => { cleanup(); resolve(); };
      const failed = (): void => { cleanup(); reject(new AppException("DESKTOP_TERMINAL_UNAVAILABLE", "Terminal connection failed", 503)); };
      const timer = setTimeout(failed, options.connectTimeoutMs ?? 15_000);
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      signal.addEventListener("abort", failed, { once: true });
      if (signal.aborted) failed();
    });
  } catch (error) { socket.close(); throw error; }
  void (async () => {
    const reader = input.getReader(); const decoder = new TextDecoder(); let pending = "";
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        if (pending.length > 1024 * 1024) throw new Error("Terminal frame is too large");
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          if (socket.bufferedAmount > 1024 * 1024) throw new Error("Terminal consumer is too slow");
          socket.send(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        }
      }
    } catch { socket.close(); }
    finally { reader.releaseLock(); }
  })();
  return new Response(output, { headers: { "content-type": "application/x-ndjson" } });
}

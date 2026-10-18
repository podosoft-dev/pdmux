import { expect, it } from "bun:test";
import { terminalStream } from "./terminal-stream";

class StreamSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  send(): void {}
  close(): void { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event("close")); }
}

it.each(["close", "error", "abort", "timeout"])("[TC-PDDESKTOP-012] rejects an interrupted terminal handshake (%s) so the renderer can reconnect", async failure => {
  const socket = new StreamSocket();
  const abort = new AbortController();
  const pending = terminalStream("wss://server.example.test/terminal/ws", "test-cookie", new ReadableStream(), abort.signal, {
    createSocket: () => socket as unknown as WebSocket,
    connectTimeoutMs: 10,
  });
  if (failure === "close") socket.close();
  else if (failure === "error") socket.dispatchEvent(new Event("error"));
  else if (failure === "abort") abort.abort();
  await expect(pending).rejects.toMatchObject({ code: "DESKTOP_TERMINAL_UNAVAILABLE" });
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

it("[TC-PDDESKTOP-012] does not open a terminal after cancellation", async () => {
  const abort = new AbortController(); abort.abort();
  let opened = false;
  await expect(terminalStream("wss://server.example.test/terminal/ws", "test-cookie", new ReadableStream(), abort.signal, {
    createSocket: () => { opened = true; return new StreamSocket() as unknown as WebSocket; },
  })).rejects.toMatchObject({ code: "DESKTOP_TERMINAL_UNAVAILABLE" });
  expect(opened).toBe(false);
});

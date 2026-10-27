import { bridgeFrameSchema, CHUNK_BYTES, MAX_CHANNELS, MAX_FRAME_BYTES, WINDOW_CHUNKS, type BridgeFrame, type BridgeRequest } from "@pdmux/desktop-protocol";
import { AppException } from "../common/app-exception";

interface Channel {
  controller: ReadableStreamDefaultController<Uint8Array>;
  response: (response: Response) => void;
  reject: (error: Error) => void;
  abort: AbortController;
  credits: number;
  received: number;
  wake?: () => void;
  incomingDone: boolean;
  headReceived: boolean;
  outgoingDone: boolean;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  timer?: ReturnType<typeof setTimeout>;
}
export type BridgeHandler = (request: BridgeRequest, body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>;

/** Bounded, duplex streams. Credits are returned only when the HTTP consumer reads. */
export class DesktopBridge {
  private readonly channels = new Map<string, Channel>();
  private closed = false;
  constructor(private readonly send: (data: string) => void, private readonly handle: BridgeHandler, private readonly onClose: () => void = () => undefined) {}

  async request(input: BridgeRequest, body?: ReadableStream<Uint8Array> | null, signal?: AbortSignal): Promise<Response> {
    if (this.closed) throw new AppException("DESKTOP_OFFLINE", "The desktop is offline", 503);
    if (this.channels.size >= MAX_CHANNELS) throw new AppException("DESKTOP_BUSY", "Too many desktop operations", 429);
    const id = crypto.randomUUID();
    let accept!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<Response>((resolve, fail) => { accept = resolve; reject = fail; });
    const { channel } = this.create(id, accept, reject);
    const onAbort = (): void => this.cancel(id);
    signal?.addEventListener("abort", onAbort, { once: true });
    channel.abort.signal.addEventListener("abort", () => signal?.removeEventListener("abort", onAbort), { once: true });
    if (signal?.aborted) this.cancel(id);
    else {
      this.emit({ type: "open", id, ...input });
      void this.pump(id, body ?? new ReadableStream({ start(controller) { controller.close(); } }));
    }
    return response;
  }

  receive(raw: unknown): void {
    if (this.closed || typeof raw !== "string" || Buffer.byteLength(raw) > MAX_FRAME_BYTES) { this.close(); return; }
    let frame: BridgeFrame;
    try { frame = bridgeFrameSchema.parse(JSON.parse(raw)); } catch { this.close(); return; }
    if (frame.type === "open") {
      if (this.channels.has(frame.id) || this.channels.size >= MAX_CHANNELS) { this.emit({ type: "error", id: frame.id, code: "DESKTOP_BUSY" }); return; }
      const { channel, stream } = this.create(frame.id, () => undefined, () => undefined);
      clearTimeout(channel.timer);
      channel.timer = setTimeout(() => this.cancel(frame.id), 360_000);
      void this.handle(frame, stream, channel.abort.signal).then(response => {
        if (!this.channels.has(frame.id)) { void response.body?.cancel(); return; }
        clearTimeout(channel.timer);
        this.emit({ type: "head", id: frame.id, status: response.status, headers: safeHeaders(response.headers) });
        return this.pump(frame.id, response.body ?? new ReadableStream({ start(controller) { controller.close(); } }));
      }).catch(() => this.cancel(frame.id));
      return;
    }
    const channel = this.channels.get(frame.id);
    if (!channel) return;
    switch (frame.type) {
      case "head":
        if (channel.headReceived) { this.close(); return; }
        channel.headReceived = true;
        clearTimeout(channel.timer);
        // The stream was created once; its queue is bounded to WINDOW_CHUNKS.
        channel.response(new Response([204, 205, 304].includes(frame.status) ? null : this.streams.get(frame.id), { status: frame.status, headers: frame.headers }));
        break;
      case "chunk": {
        if (channel.incomingDone || ++channel.received > WINDOW_CHUNKS || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) { this.close(); return; }
        const bytes = Buffer.from(frame.data, "base64");
        if (bytes.length > CHUNK_BYTES) { this.close(); return; }
        channel.controller.enqueue(bytes);
        break;
      }
      case "credit":
        channel.credits += frame.count;
        if (channel.credits > WINDOW_CHUNKS) { this.close(); return; }
        channel.wake?.(); channel.wake = undefined;
        break;
      case "end":
        if (channel.incomingDone) { this.close(); return; }
        channel.incomingDone = true;
        channel.controller.close();
        this.finish(frame.id);
        break;
      case "cancel": case "error":
        this.dispose(frame.id, new AppException("DESKTOP_DISCONNECTED", "Desktop operation was interrupted", 503));
        break;
    }
  }

  private readonly streams = new Map<string, ReadableStream<Uint8Array>>();
  private create(id: string, response: Channel["response"], reject: Channel["reject"]): { channel: Channel; stream: ReadableStream<Uint8Array> } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull: () => {
        const current = this.channels.get(id);
        if (current && current.received > 0) { current.received -= 1; this.emit({ type: "credit", id, count: 1 }); }
      },
      cancel: () => this.cancel(id),
    }, { highWaterMark: 0 });
    const channel: Channel = { controller, response, reject, abort: new AbortController(), credits: WINDOW_CHUNKS, received: 0, headReceived: false, incomingDone: false, outgoingDone: false };
    channel.timer = setTimeout(() => this.cancel(id), 360_000);
    this.channels.set(id, channel); this.streams.set(id, stream);
    return { channel, stream };
  }

  private async pump(id: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const channel = this.channels.get(id);
    if (!channel) { await stream.cancel(); return; }
    const reader = stream.getReader(); channel.reader = reader;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        for (let offset = 0; offset < result.value.length; offset += CHUNK_BYTES) {
          while (channel.credits === 0 && !channel.abort.signal.aborted) await new Promise<void>(resolve => { channel.wake = resolve; });
          if (channel.abort.signal.aborted) return;
          channel.credits -= 1;
          this.emit({ type: "chunk", id, data: Buffer.from(result.value.subarray(offset, offset + CHUNK_BYTES)).toString("base64") });
        }
      }
      channel.outgoingDone = true;
      this.emit({ type: "end", id });
      this.finish(id);
    } catch { this.cancel(id); }
    finally { reader.releaseLock(); }
  }
  private emit(frame: BridgeFrame): void { if (!this.closed) { try { this.send(JSON.stringify(frame)); } catch { this.close(); } } }
  private finish(id: string): void {
    const channel = this.channels.get(id);
    if (channel?.incomingDone && channel.outgoingDone) {
      clearTimeout(channel.timer); channel.abort.abort(); this.channels.delete(id); this.streams.delete(id);
    }
  }
  private cancel(id: string): void { this.emit({ type: "cancel", id }); this.dispose(id, new AppException("DESKTOP_DISCONNECTED", "Desktop operation was interrupted", 503)); }
  private dispose(id: string, error: Error): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    clearTimeout(channel.timer); channel.abort.abort(); channel.wake?.();
    void channel.reader?.cancel().catch(() => undefined);
    try { if (!channel.incomingDone) channel.controller.error(error); } catch { /* Already consumed. */ }
    channel.reject(error); this.channels.delete(id); this.streams.delete(id);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    for (const id of this.channels.keys()) this.dispose(id, new AppException("DESKTOP_OFFLINE", "The desktop is offline", 503));
  }
}

export function safeHeaders(headers: Headers): Record<string, string> {
  // An upload chunk names its position and digest in headers; without them the original
  // backend rejects every chunk and the transfer pauses itself.
  const allowed = new Set(["content-type", "content-disposition", "content-length", "content-range", "accept-ranges", "range", "etag", "retry-after", "x-content-type-options",
    "x-transfer-offset", "x-transfer-sha256"]);
  // fetch decodes compressed bodies but retains their wire headers. Neither the
  // encoding nor its compressed length describes the stream we relay now.
  return Object.fromEntries([...headers].filter(([key]) => allowed.has(key) && (key !== "content-length" || !headers.has("content-encoding"))));
}

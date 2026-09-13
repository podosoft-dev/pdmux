/** One visible-page SSE subscription; REST polling remains the recovery path. */
export class FleetEvents {
  private source: EventSource | null = null;
  private started = false;

  constructor(private readonly refresh: () => Promise<void>) {}

  private readonly visibility = (): void => {
    this.disconnect();
    if (document.visibilityState !== "hidden") this.connect();
  };

  start(): void {
    if (this.started || typeof EventSource === "undefined" || typeof document === "undefined") return;
    this.started = true;
    document.addEventListener("visibilitychange", this.visibility);
    this.visibility();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    document.removeEventListener("visibilitychange", this.visibility);
    this.disconnect();
  }

  private connect(): void {
    this.source = new EventSource("/api/fleet/events");
    this.source.onmessage = (event: MessageEvent<string>): void => {
      try {
        const data: unknown = JSON.parse(event.data);
        if (typeof data !== "object" || data === null || !("type" in data)) return;
        if (data.type === "hosts.changed" || data.type === "ready") void this.refresh();
      } catch { /* Invalid events do not interrupt the polling recovery path. */ }
    };
  }

  private disconnect(): void {
    if (this.source) this.source.onmessage = null;
    this.source?.close();
    this.source = null;
  }
}

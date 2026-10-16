/** One visible-page SSE subscription; REST polling remains the recovery path. */
export class FleetEvents {
  private source: EventSource | null = null;
  private started = false;

  /**
   * `refresh` reloads the hosts on an invalidation. `reload` runs instead on
   * `resync`, which the API sends after its event bus was interrupted: notices
   * from that time were lost, so everything on screen is read again.
   */
  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly reload: () => Promise<void>,
  ) {}

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
        else if (data.type === "resync") void this.reload();
      } catch { /* Invalid events do not interrupt the polling recovery path. */ }
    };
  }

  private disconnect(): void {
    if (this.source) this.source.onmessage = null;
    this.source?.close();
    this.source = null;
  }
}

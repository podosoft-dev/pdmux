import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetEvents } from "../src/lib/dashboard/fleet-events";

class TestDocument extends EventTarget {
  visibilityState = "visible";
}
class TestSource {
  static instances: TestSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { TestSource.instances.push(this); }
  close(): void { this.closed = true; }
  send(data: string): void { this.onmessage?.({ data } as MessageEvent<string>); }
}

afterEach((): void => { vi.unstubAllGlobals(); TestSource.instances = []; });

describe("[TC-PDWEB-034] fleet event lifecycle", () => {
  it("refreshes only for recognized invalidations and reconnect readiness", (): void => {
    vi.stubGlobal("document", new TestDocument());
    vi.stubGlobal("EventSource", TestSource);
    const refresh = vi.fn(async (): Promise<void> => {});
    const events = new FleetEvents(refresh);
    events.start(); events.start();
    expect(TestSource.instances).toHaveLength(1);
    const source = TestSource.instances[0]!;
    expect(source.url).toBe("/api/fleet/events");
    source.send('{"type":"ready"}');
    source.send('{"type":"hosts.changed"}');
    source.send('{"type":"heartbeat"}'); source.send("invalid"); source.send("null");
    expect(refresh).toHaveBeenCalledTimes(2);
    events.stop();
    source.send('{"type":"hosts.changed"}');
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(source.closed).toBe(true);
  });
  it("releases hidden-page connections and stops listening after unmount", (): void => {
    const document = new TestDocument();
    vi.stubGlobal("document", document);
    vi.stubGlobal("EventSource", TestSource);
    const events = new FleetEvents(async (): Promise<void> => {});
    events.start();
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(TestSource.instances[0]?.closed).toBe(true);
    expect(TestSource.instances).toHaveLength(1);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(TestSource.instances).toHaveLength(2);
    events.stop();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(TestSource.instances).toHaveLength(2);
    expect(TestSource.instances[1]?.closed).toBe(true);
  });
});

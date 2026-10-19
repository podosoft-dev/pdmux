import { describe, expect, it } from "bun:test";
import { settlesWithin, Shutdown, stopGracefully, type StoppableServer } from "./shutdown";

describe("Shutdown", () => {
  it("runs each listener once when shutdown starts and aborts its signal", () => {
    const shutdown = new Shutdown();
    const calls: string[] = [];
    shutdown.onShutdown(() => calls.push("first"));
    shutdown.onShutdown(() => calls.push("second"));

    shutdown.begin();
    shutdown.begin();

    expect(calls).toEqual(["first", "second"]);
    expect(shutdown.started).toBe(true);
    expect(shutdown.signal.aborted).toBe(true);
  });

  it("skips a listener whose connection closed on its own", () => {
    const shutdown = new Shutdown();
    const calls: string[] = [];
    const release = shutdown.onShutdown(() => calls.push("closed"));
    shutdown.onShutdown(() => calls.push("open"));

    release();
    shutdown.begin();

    expect(calls).toEqual(["open"]);
  });

  it("runs a listener registered after shutdown started at once", () => {
    const shutdown = new Shutdown();
    shutdown.begin();
    let ran = false;

    shutdown.onShutdown(() => {
      ran = true;
    })();

    expect(ran).toBe(true);
  });

  it("reports a failing listener and still runs the others", () => {
    const errors: unknown[] = [];
    const shutdown = new Shutdown((error) => errors.push(error));
    let ran = false;
    shutdown.onShutdown(() => {
      throw new Error("socket already closed");
    });
    shutdown.onShutdown(() => {
      ran = true;
    });

    shutdown.begin();

    expect(ran).toBe(true);
    expect(errors).toEqual([new Error("socket already closed")]);
  });
});

describe("settlesWithin", () => {
  it("tells a promise that settled in time, rejected or not, from one that did not", async () => {
    expect(await settlesWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settlesWithin(Promise.reject(new Error("failed")), 50)).toBe(true);
    expect(await settlesWithin(new Promise(() => {}), 10)).toBe(false);
  });
});

function fakeServer(): StoppableServer & { forced: number } {
  return {
    forced: 0,
    stop(force?: boolean): Promise<void> {
      if (force) this.forced += 1;
      return new Promise(() => {});
    },
  };
}

describe("stopGracefully", () => {
  it("stops accepting before it ends streams, waits for the drain, then closes the services", async () => {
    const order: string[] = [];
    const shutdown = new Shutdown();
    shutdown.onShutdown(() => order.push("end streams"));
    let finishDrain = (): void => undefined;
    const stopping = stopGracefully({
      stop: () => {
        order.push("stop accepting");
        return new Promise<void>((resolve) => {
          finishDrain = resolve;
        });
      },
      shutdown,
      closeServices: async () => {
        order.push("close services");
      },
      timeoutMs: 5_000,
    });
    await Bun.sleep(10);
    expect(order).toEqual(["stop accepting", "end streams"]);

    finishDrain();

    expect(await stopping).toEqual({ drained: true, servicesClosed: true });
    expect(order).toEqual(["stop accepting", "end streams", "close services"]);
  });

  it("force-closes what is still open at the timeout and bounds every later wait", async () => {
    const server = fakeServer();
    let closed = false;
    const started = performance.now();

    const result = await stopGracefully({
      stop: () => server.stop(),
      server,
      shutdown: new Shutdown(),
      closeServices: () => new Promise<void>(() => {
        closed = true;
      }),
      timeoutMs: 30,
      forceCloseMs: 30,
      closeServicesMs: 30,
    });

    expect(result).toEqual({ drained: false, servicesClosed: false });
    expect(server.forced).toBe(1);
    expect(closed).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

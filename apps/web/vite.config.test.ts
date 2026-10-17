import { describe, expect, it } from "vitest";
import { webSocketProxy } from "./vite.config.ts";

describe("dev-server WebSocket proxy", () => {
  it("sends each exact path in .podokit/dev.json to the API", () => {
    const proxy = webSocketProxy(
      JSON.stringify({ hostname: "app.localhost", webSocketPaths: ["/events/ws", "/agent.v1/ws"] }),
      "http://api:5002",
    );

    expect(proxy).toEqual({
      "^/events/ws(?:\\?.*)?$": { target: "http://api:5002", ws: true, xfwd: true },
      "^/agent\\.v1/ws(?:\\?.*)?$": { target: "http://api:5002", ws: true, xfwd: true },
    });
    const [events] = Object.keys(proxy).map((key) => new RegExp(key));
    expect(events?.test("/events/ws")).toBe(true);
    expect(events?.test("/events/ws?token=1")).toBe(true);
    expect(events?.test("/events/ws/other")).toBe(false);
    expect(events?.test("/events/wsx")).toBe(false);
  });

  it("proxies nothing without the file or its paths", () => {
    expect(webSocketProxy(null)).toEqual({});
    expect(webSocketProxy(JSON.stringify({ hostname: "app.localhost" }))).toEqual({});
  });

  it("rejects a path the gateway would reject", () => {
    expect(() => webSocketProxy(JSON.stringify({ webSocketPaths: ["events/ws"] }))).toThrow(
      'invalid path: "events/ws"',
    );
    expect(() => webSocketProxy(JSON.stringify({ webSocketPaths: "/events/ws" }))).toThrow("must be an array");
  });
});

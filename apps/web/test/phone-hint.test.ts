import { describe, expect, it } from "vitest";
// ⚠ NOT from the layout module. SvelteKit validates a route module's export list and
// answers 500 for any name outside its own vocabulary — this helper was exported from
// `+layout.server.ts` purely so this test could reach it, and that export took `/hosts`
// down with `Invalid export 'looksLikePhone'`.
import { looksLikePhone } from "../src/lib/server/phone-hint";

/**
 * The seed for the narrow-screen decision on the very first render.
 *
 * A media query cannot be evaluated on the server, and its default answer is "no" —
 * i.e. desktop — so a phone server-rendered the whole saved split and collapsed to a
 * single pane the moment it hydrated. This hint is what makes first paint agree with
 * the device. It is only ever a hint: the live query wins as soon as the client runs.
 */
const request = (headers: Record<string, string>): Request =>
  new Request("https://pdmux.example/", { headers });

describe("[TC-PDWEB-007] the first paint is seeded with the device's own hint", () => {
  it("believes the browser when it states the answer", () => {
    // Chromium sends this on every request, and it is the answer rather than a guess.
    expect(looksLikePhone(request({ "sec-ch-ua-mobile": "?1" }))).toBe(true);
    expect(looksLikePhone(request({ "sec-ch-ua-mobile": "?0" }))).toBe(false);

    // The client hint wins over a user-agent that disagrees — a desktop Chrome with a
    // spoofed UA string is still a desktop.
    const conflicting = { "sec-ch-ua-mobile": "?0", "user-agent": "... iPhone ..." };
    expect(looksLikePhone(request(conflicting))).toBe(false);
  });

  it("falls back to the user agent for browsers that do not send it", () => {
    // iOS Safari is the one that matters: no client hints, and the device this is for.
    const ios =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
    expect(looksLikePhone(request({ "user-agent": ios }))).toBe(true);
    expect(looksLikePhone(request({ "user-agent": mac }))).toBe(false);
    expect(looksLikePhone(request({ "user-agent": "Mozilla/5.0 (Linux; Android 14) Mobile" }))).toBe(true);
  });

  it("assumes a desktop when it is told nothing at all", () => {
    // The safe default: the wide layout is what the saved split describes, and a wrong
    // guess costs one reflow — exactly what every request used to cost.
    expect(looksLikePhone(request({}))).toBe(false);
  });
});

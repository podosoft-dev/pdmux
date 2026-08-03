import { describe, expect, it } from "vitest";
import { deviceLabel } from "./device-label";

describe("deviceLabel", () => {
  it("names the browser and the machine", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome · macOS");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome · Windows");
  });

  // Each of these contains an earlier engine's token, so a naive check in the wrong
  // order reports every one of them as Chrome or Safari.
  it("does not mistake a derivative for the engine it embeds", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0")).toBe(
      "Edge · Windows",
    );
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36 OPR/121.0.0.0")).toBe(
      "Opera · Windows",
    );
    expect(
      deviceLabel("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0.0.0 SamsungBrowser/28.0 Safari/537.36"),
    ).toBe("Samsung Internet · Android");
    expect(
      deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"),
    ).toBe("Safari · macOS");
  });

  it("names an iPhone and an iPad rather than the engine's host platform", () => {
    expect(
      deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"),
    ).toBe("Safari · iPhone");
    // iPadOS reports Macintosh in the same string, so order decides this one.
    expect(
      deviceLabel("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"),
    ).toBe("Safari · iPad");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1")).toBe(
      "Chrome · iPhone",
    );
  });

  it("gives up on something that is not a browser, so the caller can show it raw", () => {
    // The exact value is the whole point for these: "node" is the symptom of a
    // proxy that forgot to forward the header, and a CLI's name identifies it.
    expect(deviceLabel("node")).toBeNull();
    expect(deviceLabel("curl/8.7.1")).toBeNull();
    expect(deviceLabel("")).toBeNull();
    expect(deviceLabel(null)).toBeNull();
    expect(deviceLabel(undefined)).toBeNull();
  });

  it("reports whichever half it can read", () => {
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(deviceLabel("Firefox/142.0")).toBe("Firefox");
  });
});

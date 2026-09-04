import { describe, expect, it } from "bun:test";
import { isDesktopLoopbackUrl, runtimeProviders } from "./providers";

describe("[TC-PDDESKTOP-001] runtime provider profile", () => {
  it("selects external providers for the server profile", () => {
    expect(runtimeProviders({})).toEqual({
      database: "postgres",
      cache: "redis",
      objectStorage: "s3",
      events: "redis",
      jobs: "bullmq",
    });
  });

  it("selects embedded providers for the desktop profile", () => {
    expect(runtimeProviders({ PDMUX_DESKTOP: "1" })).toEqual({
      database: "sqlite",
      cache: "memory",
      objectStorage: "local",
      events: "memory",
      jobs: "local",
    });
  });

  it("allows each capability to be changed independently", () => {
    expect(runtimeProviders({
      PDMUX_DATABASE_PROVIDER: "sqlite",
      PDMUX_CACHE_PROVIDER: "memory",
      PDMUX_OBJECT_STORAGE_PROVIDER: "local",
      PDMUX_EVENTS_PROVIDER: "memory",
      PDMUX_JOBS_PROVIDER: "local",
    })).toEqual({
      database: "sqlite",
      cache: "memory",
      objectStorage: "local",
      events: "memory",
      jobs: "local",
    });
  });

  it("allows production HTTP only on the embedded loopback boundary", () => {
    expect(isDesktopLoopbackUrl("http://127.0.0.1:5001", { PDMUX_DESKTOP: "1" })).toBe(true);
    expect(isDesktopLoopbackUrl("http://example.com", { PDMUX_DESKTOP: "1" })).toBe(false);
    expect(isDesktopLoopbackUrl("http://127.0.0.1:5001", {})).toBe(false);
  });
});

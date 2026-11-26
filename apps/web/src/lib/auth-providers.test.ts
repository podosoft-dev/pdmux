import { describe, expect, it } from "vitest";
import { providerLabel, providerList } from "./auth-providers";

describe("auth provider labels", () => {
  it("names known providers and capitalizes the rest", () => {
    expect(providerLabel("github")).toBe("GitHub");
    expect(providerLabel("google")).toBe("Google");
    expect(providerLabel("gitlab")).toBe("Gitlab");
  });

  it("lists several providers", () => {
    expect(providerList(["google", "github"])).toBe("Google, GitHub");
    expect(providerList([])).toBe("");
  });
});

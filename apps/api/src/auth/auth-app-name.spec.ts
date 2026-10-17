import { describe, expect, test } from "bun:test";
import { envAuthConfig } from "@podosoft/podokit-auth";
import { buildAuth } from "./auth";

interface PluginWithOptions {
  id: string;
  options?: { rpName?: string; issuer?: string };
}

function plugin(instance: ReturnType<typeof buildAuth>, id: string): PluginWithOptions | undefined {
  return (instance.options.plugins as PluginWithOptions[]).find((candidate) => candidate.id === id);
}

describe("auth app name", () => {
  test("names the app in Better Auth, the TOTP issuer, and the passkey prompt", () => {
    const instance = buildAuth({ ...envAuthConfig(), appName: "Acme Cloud" });
    expect(instance.options.appName).toBe("Acme Cloud");
    expect(plugin(instance, "two-factor")?.options?.issuer).toBe("Acme Cloud");
    expect(plugin(instance, "passkey")?.options?.rpName).toBe("Acme Cloud");
  });
});

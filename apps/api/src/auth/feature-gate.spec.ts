import { describe, expect, test } from "bun:test";
import { FLAG_DEFAULTS, flagsFrom } from "../settings/flag-defaults";
import {
  enforceFeatureGate,
  PUBLIC_SIGNUP_DISABLED,
  signupOpenFrom,
  type FeatureFlags,
  type FeatureGateSettings,
} from "./feature-gate";

function settings(flags: Partial<FeatureFlags>, signupOpen = true): FeatureGateSettings {
  return {
    flags: async () => ({ ...FLAG_DEFAULTS, ...flags }),
    signupOpen: async () => signupOpen,
  };
}

const failing: FeatureGateSettings = {
  flags: async () => {
    throw new Error('relation "app_setting" does not exist');
  },
  signupOpen: async () => {
    throw new Error('relation "app_setting" does not exist');
  },
};

describe("feature gate", () => {
  test("rejects a disabled feature's endpoints with 404", async () => {
    await expect(enforceFeatureGate("/sign-in/magic-link", settings({ magicLink: false })))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(enforceFeatureGate("/sign-in/magic-link", settings({ magicLink: true })))
      .resolves.toBeUndefined();
    await expect(enforceFeatureGate("/get-session", settings({ magicLink: false })))
      .resolves.toBeUndefined();
  });

  test("closes public sign-up without blocking other paths", async () => {
    await expect(enforceFeatureGate("/sign-up/email", settings({}, false)))
      .rejects.toMatchObject({ body: { code: PUBLIC_SIGNUP_DISABLED } });
    await expect(enforceFeatureGate("/sign-in/social", settings({}, false)))
      .resolves.toBeUndefined();
  });

  test("fails open to defaults when the settings cannot be read", async () => {
    await expect(enforceFeatureGate("/sign-up/email", failing)).resolves.toBeUndefined();
    await expect(enforceFeatureGate("/sign-in/magic-link", failing)).resolves.toBeUndefined();
    await expect(enforceFeatureGate("/phone-number/send-otp", failing))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  test("projects stored settings over the shipped defaults", () => {
    const stored = new Map([["magicLink", "false"], ["phoneNumber", "true"], ["site.allowSignup", "false"]]);
    expect(flagsFrom(stored)).toMatchObject({ magicLink: false, phoneNumber: true, twoFactor: true });
    expect(flagsFrom(new Map())).toEqual(FLAG_DEFAULTS);
    expect(signupOpenFrom(stored)).toBe(false);
    expect(signupOpenFrom(new Map())).toBe(true);
  });
});

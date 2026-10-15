import { afterEach, describe, expect, test } from "bun:test";
import type { SmtpConfig } from "@podosoft/podokit-auth";
import type { Transporter } from "nodemailer";
import { mailTransport, setMailConfigStore, setMailTransport } from "./mailer";

function storeOf(read: () => SmtpConfig | null) {
  let calls = 0;
  return {
    store: {
      smtpConfig: async (): Promise<SmtpConfig | null> => {
        calls += 1;
        return read();
      },
    },
    calls: (): number => calls,
  };
}

afterEach(() => {
  setMailTransport(null);
});

describe("mailer transport", () => {
  test("reuses the transport while the SMTP settings are unchanged", async () => {
    let smtp: SmtpConfig | null = { host: "smtp.example.com", port: 587, secure: false, user: "u", pass: "p" };
    const { store, calls } = storeOf(() => smtp);
    setMailConfigStore(store);

    const first = await mailTransport();
    expect(await mailTransport()).toBe(first);
    smtp = { ...smtp };
    expect(await mailTransport()).toBe(first);
    expect(calls()).toBe(3);

    smtp = { ...smtp, host: "smtp2.example.com" };
    const second = await mailTransport();
    expect(second).not.toBe(first);
    expect(await mailTransport()).toBe(second);
  });

  test("falls back to the environment when the store fails, and honours an override", async () => {
    setMailConfigStore({
      smtpConfig: async () => {
        throw new Error('relation "auth_config" does not exist');
      },
    });
    const fallback = await mailTransport();
    expect(fallback).toBeDefined();

    const custom = { sendMail: async () => ({}) } as unknown as Transporter;
    setMailTransport(custom);
    expect(await mailTransport()).toBe(custom);
  });
});

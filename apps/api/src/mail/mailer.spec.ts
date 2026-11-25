import { afterEach, describe, expect, test } from "bun:test";
import type { SmtpConfig } from "@podosoft/podokit-auth";
import type { Transporter } from "nodemailer";
import { mailTransport, sendMail, setMailConfigStore, setMailTransport } from "./mailer";

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

  test("passes an optional Reply-To to the transport and leaves it out otherwise", async () => {
    const sent: Array<Record<string, unknown>> = [];
    setMailTransport({
      sendMail: async (mail: Record<string, unknown>) => {
        sent.push(mail);
        return {};
      },
    } as unknown as Transporter);

    await sendMail({ to: "ops@example.com", subject: "Inquiry", text: "Hi", replyTo: "visitor@example.com" });
    await sendMail({ to: "ops@example.com", subject: "Plain", text: "Hi" });

    expect(sent[0]?.replyTo).toBe("visitor@example.com");
    expect(sent[1]).not.toHaveProperty("replyTo");
  });
});

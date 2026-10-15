import nodemailer, { type Transporter } from "nodemailer";
import { createConfigStore, type SmtpConfig } from "@podosoft/podokit-auth";

// Reusable email sending. SMTP is resolved in priority order, applied live so no
// restart is needed:
//   1. admin-configured DB settings (auth_config) — only when the auth module is
//      installed; read from the shared config snapshot, which decrypts the SMTP
//      password once per change and follows the snapshot TTL;
//   2. SMTP_* env (fallback / production secrets-manager injection);
//   3. none → a JSON transport that logs the message so dev links are grabbable.
// The whole transport can also be overridden from app code (setMailTransport),
// e.g. from apps/api/src/app.extensions.ts, to plug in a provider SDK.
type MailConfigStore = Pick<ReturnType<typeof createConfigStore>, "smtpConfig">;
let store: MailConfigStore | undefined;
const DEFAULT_FROM = "PodoKit <no-reply@example.com>";

export function setMailConfigStore(configStore: MailConfigStore): void {
  store = configStore;
}

function envSmtp(): SmtpConfig | null {
  if (!process.env.SMTP_HOST) return null;
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM,
  };
}

async function resolveSmtp(): Promise<SmtpConfig | null> {
  try {
    // Reads auth_config and falls back to env internally when auth is installed.
    return store ? await store.smtpConfig() : envSmtp();
  } catch {
    // No auth_config table (auth not installed) — use env directly.
    return envSmtp();
  }
}

function buildTransport(smtp: SmtpConfig | null): Transporter {
  if (!smtp) return nodemailer.createTransport({ jsonTransport: true });
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? "" } : undefined,
  });
}

type MailSetup = {
  smtp: SmtpConfig | null;
  signature: string;
  transport: Transporter;
  from: string;
};

let setup: MailSetup = {
  smtp: null,
  signature: "null",
  transport: buildTransport(null),
  from: process.env.MAIL_FROM ?? DEFAULT_FROM,
};
let override: Transporter | null = null;

/** Override the transport from app code (e.g. a provider SDK). Pass null to
 *  restore the config-driven transport. Set this from app.extensions.ts. */
export function setMailTransport(custom: Transporter | null): void {
  override = custom;
}

/** The config-driven setup. The store returns the same SMTP object until the
 *  config changes, and the transport is rebuilt only when its settings differ. */
async function currentSetup(): Promise<MailSetup> {
  const smtp = await resolveSmtp();
  if (smtp === setup.smtp) return setup;
  const signature = JSON.stringify(smtp);
  if (signature === setup.signature) {
    setup = { ...setup, smtp };
    return setup;
  }
  try {
    setup = {
      smtp,
      signature,
      transport: buildTransport(smtp),
      from: smtp?.from ?? process.env.MAIL_FROM ?? DEFAULT_FROM,
    };
  } catch {
    /* keep the last-good transport */
  }
  return setup;
}

/** The transport `sendMail` uses now: the override, or the one built from SMTP config. */
export async function mailTransport(): Promise<Transporter> {
  return override ?? (await currentSetup()).transport;
}

export type Mail = { to: string; subject: string; text: string; html?: string };

export async function sendMail(mail: Mail): Promise<void> {
  if (override) {
    await override.sendMail({ from: setup.from, ...mail });
    return;
  }
  const current = await currentSetup();
  const info = await current.transport.sendMail({ from: current.from, ...mail });
  if (!current.smtp) {
    // JSON transport: surface the message so the link is grabbable from logs.
    console.log(`[mailer] no SMTP configured; message not delivered:\n${info.message as string}`);
  }
}

// Minimal HTML wrapper for a titled call-to-action email.
export function actionEmail(title: string, body: string, url: string, cta: string): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto">
  <h1 style="font-size:20px">${title}</h1>
  <p>${body}</p>
  <p><a href="${url}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:8px;text-decoration:none">${cta}</a></p>
  <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${url}</p>
</div>`;
}

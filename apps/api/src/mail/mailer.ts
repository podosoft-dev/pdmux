import nodemailer, { type Transporter } from "nodemailer";
import { pool } from "./db";
import { createConfigStore, type SmtpConfig } from "@podosoft/podokit-auth";

// Reusable email sending. SMTP is resolved in priority order, applied live (short
// TTL) so no restart is needed:
//   1. admin-configured DB settings (auth_config) — only when the auth module is
//      installed; read via the config store, which decrypts the SMTP password;
//   2. SMTP_* env (fallback / production secrets-manager injection);
//   3. none → a JSON transport that logs the message so dev links are grabbable.
// The whole transport can also be overridden from app code (setMailTransport),
// e.g. from apps/api/src/app.extensions.ts, to plug in a provider SDK.
const store = createConfigStore(pool);
const TTL_MS = 3_000;

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
    return await store.smtpConfig();
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

let transport = buildTransport(null);
let transportFrom = process.env.MAIL_FROM ?? "PodoKit <no-reply@example.com>";
let hasSmtp = false;
let checkedAt = 0;
let signature = "";
let override: Transporter | null = null;

/** Override the transport from app code (e.g. a provider SDK). Pass null to
 *  restore the config-driven transport. Set this from app.extensions.ts. */
export function setMailTransport(custom: Transporter | null): void {
  override = custom;
}

async function getTransport(): Promise<Transporter> {
  if (override) return override;
  if (checkedAt !== 0 && Date.now() - checkedAt < TTL_MS) return transport;
  checkedAt = Date.now();
  try {
    const smtp = await resolveSmtp();
    const next = JSON.stringify(smtp ?? null);
    if (next !== signature) {
      transport = buildTransport(smtp);
      transportFrom = smtp?.from ?? process.env.MAIL_FROM ?? "PodoKit <no-reply@example.com>";
      hasSmtp = !!smtp;
      signature = next;
    }
  } catch {
    /* keep the last-good transport */
  }
  return transport;
}

export type Mail = { to: string; subject: string; text: string; html?: string };

export async function sendMail(mail: Mail): Promise<void> {
  const t = await getTransport();
  const info = await t.sendMail({ from: transportFrom, ...mail });
  if (!override && !hasSmtp) {
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

import nodemailer, { type Transporter } from 'nodemailer';
import type { Sql } from '../db.js';
import { AppError, unprocessable } from './errors.js';
import { decryptSecret } from './secrets.js';

export interface SmtpRow {
  enabled: boolean; host: string; port: number; secure: boolean; username: string | null; passwordEnc: string | null; fromName: string; fromEmail: string;
}

/** Transport pengganti (dipakai test: jsonTransport). Null di production. */
let override: Transporter | null = null;
export function setMailTransportOverride(t: Transporter | null) { override = t; }

export async function loadSmtp(sql: Sql, tenantId: string): Promise<SmtpRow | null> {
  const [r] = await sql`SELECT enabled, host, port, secure, username, password_enc, from_name, from_email FROM smtp_settings WHERE tenant_id = ${tenantId}`;
  if (!r) return null;
  return { enabled: r.enabled as boolean, host: r.host as string, port: r.port as number, secure: r.secure as boolean, username: r.username as string | null,
    passwordEnc: r.passwordEnc as string | null, fromName: r.fromName as string, fromEmail: r.fromEmail as string };
}

export function transportFor(cfg: SmtpRow): Transporter {
  if (override) return override;
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.passwordEnc ? decryptSecret(cfg.passwordEnc) : undefined } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });
}

export interface MailMessage { to: string[]; subject: string; html: string; text?: string }

/** Kirim email memakai SMTP tenant. Gagal bila SMTP belum dikonfigurasi/diaktifkan. */
export async function sendMail(sql: Sql, tenantId: string, msg: MailMessage, opts: { allowDisabled?: boolean } = {}): Promise<{ messageId: string; accepted: string[] }> {
  const cfg = await loadSmtp(sql, tenantId);
  if (!cfg || (!cfg.enabled && !opts.allowDisabled)) throw new AppError(409, 'SMTP_NOT_CONFIGURED', 'SMTP belum dikonfigurasi/diaktifkan oleh admin');
  if (!msg.to.length) throw unprocessable('Penerima email kosong');
  try {
    const info = await transportFor(cfg).sendMail({
      from: { name: cfg.fromName, address: cfg.fromEmail }, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text ?? undefined,
    });
    return { messageId: String(info.messageId ?? ''), accepted: (info.accepted ?? []).map(String) };
  } catch (e) {
    throw new AppError(502, 'SMTP_FAILED', `Pengiriman email gagal: ${(e as Error).message.slice(0, 200)}`);
  }
}


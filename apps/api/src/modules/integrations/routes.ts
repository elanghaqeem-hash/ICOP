import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requirePerm } from '../../lib/context.js';
import { conflict, notFound } from '../../lib/errors.js';
import { sendMail, loadSmtp } from '../../lib/mailer.js';
import { encryptSecret, last4 } from '../../lib/secrets.js';
import { loadQuotation, redactQuotation } from '../quotations/routes.js';
import { renderQuotationHtml } from '../quotations/render.js';
import { createHash, randomBytes } from 'node:crypto';
import { INTEGRATIONS, INTEGRATION_KINDS, getIntegration, integrationDef, recordTest, saveIntegration, type IntegrationKind } from '../../lib/integrations.js';
import { syncExisting, testStorage } from '../../lib/storage.js';
import { AppError } from '../../lib/errors.js';
import { testVida } from '../contracts/esign.js';
import { pullTenderFeed } from '../tenders/feed.js';

const SmtpBody = z.object({
  enabled: z.boolean(),
  host: z.string().min(3).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().max(255).nullable().optional(),
  password: z.string().min(1).max(500).nullable().optional(), // undefined = pertahankan; null = hapus
  fromName: z.string().min(2).max(120),
  fromEmail: z.string().email(),
});

export async function integrationRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };
  const A = requirePerm('integration.admin');

  app.get('/api/v1/integrations/smtp', { ...auth, preValidation: A }, async (req) => {
    const [r] = await sql`SELECT enabled, host, port, secure, username, password_last4, from_name, from_email, updated_at FROM smtp_settings WHERE tenant_id = ${req.authUser.tenantId}`;
    if (!r) return { configured: false, enabled: false, host: '', port: 587, secure: false, username: '', passwordMasked: null, fromName: '', fromEmail: '', updatedAt: null };
    return { configured: true, enabled: r.enabled, host: r.host, port: r.port, secure: r.secure, username: r.username ?? '',
      passwordMasked: r.passwordLast4 ? `••••${r.passwordLast4}` : null, fromName: r.fromName, fromEmail: r.fromEmail, updatedAt: r.updatedAt };
  });

  /** Simpan konfigurasi SMTP. Password dienkripsi (AES-256-GCM) dan tidak pernah dikembalikan. */
  app.put('/api/v1/integrations/smtp', { ...auth, preValidation: A }, async (req) => {
    const b = SmtpBody.parse(req.body);
    const u = req.authUser;
    const [before] = await sql`SELECT password_enc FROM smtp_settings WHERE tenant_id = ${u.tenantId}`;
    let pwEnc: string | null | undefined = undefined; let pwLast: string | null | undefined = undefined;
    if (b.password === null) { pwEnc = null; pwLast = null; }
    else if (typeof b.password === 'string') { pwEnc = encryptSecret(b.password); pwLast = last4(b.password); }
    await sql`INSERT INTO smtp_settings (tenant_id, enabled, host, port, secure, username, password_enc, password_last4, from_name, from_email, updated_by, updated_at)
      VALUES (${u.tenantId}, ${b.enabled}, ${b.host}, ${b.port}, ${b.secure}, ${b.username ?? null}, ${pwEnc ?? null}, ${pwLast ?? null}, ${b.fromName}, ${b.fromEmail}, ${u.id}, now())
      ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, host = EXCLUDED.host, port = EXCLUDED.port, secure = EXCLUDED.secure,
        username = EXCLUDED.username,
        password_enc = ${pwEnc === undefined ? sql`smtp_settings.password_enc` : pwEnc},
        password_last4 = ${pwLast === undefined ? sql`smtp_settings.password_last4` : pwLast},
        from_name = EXCLUDED.from_name, from_email = EXCLUDED.from_email, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(sql, u, 'smtp.update', 'smtp_settings', u.tenantId, { hadPassword: !!before?.passwordEnc }, { host: b.host, port: b.port, secure: b.secure, enabled: b.enabled,
      passwordChanged: pwEnc !== undefined }, req.ip);
    return { ok: true };
  });

  /** Uji koneksi: kirim email uji ke alamat admin (berjalan walau fitur belum diaktifkan). */
  app.post('/api/v1/integrations/smtp/test', { ...auth, preValidation: A }, async (req) => {
    const { to } = z.object({ to: z.string().email() }).parse(req.body);
    const u = req.authUser;
    if (!(await loadSmtp(sql, u.tenantId))) throw notFound('Konfigurasi SMTP');
    const r = await sendMail(sql, u.tenantId, { to: [to], subject: 'Uji koneksi SMTP — ICOP CyberBusiness 360',
      html: `<p>Ini email uji dari ICOP CyberBusiness 360. Jika Anda menerima pesan ini, konfigurasi SMTP sudah benar.</p>`,
      text: 'Email uji dari ICOP CyberBusiness 360. Konfigurasi SMTP sudah benar.' }, { allowDisabled: true });
    await audit(sql, u, 'smtp.test', 'smtp_settings', u.tenantId, null, { to: 'redacted', accepted: r.accepted.length }, req.ip);
    return { ok: true, accepted: r.accepted.length, messageId: r.messageId };
  });

  /** Kirim surat penawaran (quotation ISSUED/SENT) ke alamat customer via SMTP tenant. */
  app.post('/api/v1/quotations/:id/send-email', { ...auth, preValidation: requirePerm('quotation.submit') }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ to: z.array(z.string().email()).min(1).max(10), message: z.string().max(1000).optional() }).parse(req.body);
    const u = req.authUser;
    const q = await loadQuotation(sql, u.tenantId, id);
    if (!['ISSUED', 'SENT'].includes(q.status as string)) throw conflict(`Quotation berstatus ${q.status}; hanya quotation terbit yang dapat dikirim`);
    const html = renderQuotationHtml(redactQuotation(q) as never);
    const intro = b.message ? `<p>${b.message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c])}</p>` : '';
    const r = await sendMail(sql, u.tenantId, { to: b.to, subject: `Penawaran ${q.number} — ${q.title}`,
      html: `${intro}<p>Terlampir surat penawaran kami. Silakan tinjau dokumen di bawah ini.</p><hr>${html}` });
    await audit(sql, u, 'quotation.email_sent', 'quotation', id, null, { recipients: b.to.length, accepted: r.accepted.length }, req.ip);
    return { ok: true, accepted: r.accepted };
  });

  /* ───── Registri integrasi (e-sign, object storage, feed tender) ───── */
  app.get('/api/v1/integrations', { ...auth, preValidation: A }, async (req) => {
    const rows = await sql`SELECT kind, enabled, config, secret_hint, last_test_at, last_test_ok, last_test_message, last_run_at, updated_at FROM integration_credentials WHERE tenant_id = ${req.authUser.tenantId}`;
    const map = new Map(rows.map((r) => [r.kind as string, r]));
    const synced = await sql`SELECT count(*)::int AS n, coalesce(sum(size_bytes), 0)::bigint AS bytes FROM storage_objects WHERE tenant_id = ${req.authUser.tenantId}`;
    return { items: INTEGRATIONS.map((d) => {
      const r = map.get(d.kind);
      return { kind: d.kind, label: d.label, description: d.description, status: d.status, configFields: d.configFields, secretFields: d.secretFields,
        configured: !!r, enabled: !!r?.enabled, config: r?.config ?? {}, secretHint: r?.secretHint ?? null, lastTestAt: r?.lastTestAt ?? null, lastTestOk: r?.lastTestOk ?? null,
        lastTestMessage: r?.lastTestMessage ?? null, lastRunAt: r?.lastRunAt ?? null, updatedAt: r?.updatedAt ?? null };
    }), storage: { objects: synced[0].n, bytes: Number(synced[0].bytes) } };
  });

  app.put('/api/v1/integrations/:kind', { ...auth, preValidation: A }, async (req) => {
    const { kind } = z.object({ kind: z.enum(INTEGRATION_KINDS) }).parse(req.params);
    const b = z.object({ enabled: z.boolean(), config: z.record(z.unknown()), secrets: z.record(z.string().max(2000)).optional() }).parse(req.body);
    const u = req.authUser;
    const out = await saveIntegration(sql, u.tenantId, u.id, kind, b);
    await audit(sql, u, 'integration.update', 'integration', null, null, { kind, enabled: b.enabled, secretsChanged: Object.keys(b.secrets ?? {}).filter((k) => b.secrets![k]) }, req.ip);
    return { ok: true, kind, ...out };
  });

  /** Uji koneksi per jenis integrasi; hasil dicatat (tanpa rahasia). */
  app.post('/api/v1/integrations/:kind/test', { ...auth, preValidation: A }, async (req) => {
    const { kind } = z.object({ kind: z.enum(INTEGRATION_KINDS) }).parse(req.params);
    const u = req.authUser;
    const it = await getIntegration(sql, u.tenantId, kind as IntegrationKind);
    if (!it) throw notFound('Konfigurasi integrasi');
    const def = integrationDef(kind)!;
    const sec = def.secrets.safeParse(it.secrets);
    if (!sec.success) throw new AppError(400, 'BAD_REQUEST', 'Kredensial belum lengkap');
    let ok = false; let message = '';
    try {
      if (kind === 'ESIGN_VIDA') { const r = await testVida(it.config, it.secrets); ok = r.ok; message = `Token VIDA diterima (berlaku ${r.expiresIn ?? '?'} detik)`; }
      else if (kind === 'STORAGE_S3') { await testStorage(it.config, it.secrets); ok = true; message = `Bucket ${it.config.bucket}: tulis/baca/hapus OK`; }
      else if (kind === 'TENDER_FEED') {
        const res = await fetch(it.config.url, { method: 'HEAD', headers: it.secrets.apiKey ? { authorization: `Bearer ${it.secrets.apiKey}` } : {}, signal: AbortSignal.timeout(10_000) }).catch((e) => { throw new Error(e.message); });
        ok = res.ok || res.status === 405; message = `Feed merespons HTTP ${res.status}`;
      } else { ok = false; message = 'Kredensial Privy tersimpan. Uji koneksi menunggu spesifikasi API resmi Privy.'; }
    } catch (e) { ok = false; message = (e as Error).message.slice(0, 300); }
    await recordTest(sql, u.tenantId, kind as IntegrationKind, ok, message);
    await audit(sql, u, 'integration.test', 'integration', null, null, { kind, ok }, req.ip);
    return { ok, message };
  });

  app.post('/api/v1/integrations/STORAGE_S3/sync', { ...auth, preValidation: A }, async (req) => {
    const r = await syncExisting(sql, req.authUser.tenantId);
    await audit(sql, req.authUser, 'storage.sync', 'integration', null, null, r, req.ip);
    return r;
  });

  app.post('/api/v1/integrations/TENDER_FEED/run', { ...auth, preValidation: A }, async (req) => {
    const r = await pullTenderFeed(sql, req.authUser.tenantId, req.authUser.id);
    await audit(sql, req.authUser, 'tender_feed.run', 'integration', null, null, { received: r.received, created: r.created.length, invalid: r.invalid }, req.ip);
    return r;
  });

  /* ───── API key layanan (ingest SOC/VAPT ke helpdesk) — ditampilkan sekali, disimpan sebagai hash ───── */
  app.get('/api/v1/integrations/api-keys', { ...auth, preValidation: A }, async (req) => {
    const rows = await sql`SELECT k.id, k.name, k.scope, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at, c.legal_name AS customer_name, u.full_name AS created_by_name
      FROM service_api_keys k LEFT JOIN customers c ON c.id = k.customer_id LEFT JOIN users u ON u.id = k.created_by WHERE k.tenant_id = ${req.authUser.tenantId} ORDER BY k.created_at DESC`;
    return { items: rows };
  });

  app.post('/api/v1/integrations/api-keys', { ...auth, preValidation: A }, async (req, reply) => {
    const b = z.object({ name: z.string().min(3).max(120), scope: z.enum(['INGEST_SOC', 'INGEST_VAPT']), customerId: z.string().uuid().optional() }).parse(req.body);
    const u = req.authUser;
    if (b.customerId) { const [c] = await sql`SELECT 1 FROM customers WHERE id = ${b.customerId} AND tenant_id = ${u.tenantId}`; if (!c) throw notFound('Customer'); }
    const prefix = randomBytes(4).toString('hex');
    const key = `icop_${prefix}_${randomBytes(24).toString('base64url')}`;
    const [row] = await sql`INSERT INTO service_api_keys (tenant_id, name, scope, customer_id, key_prefix, key_hash, created_by)
      VALUES (${u.tenantId}, ${b.name}, ${b.scope}, ${b.customerId ?? null}, ${prefix}, ${createHash('sha256').update(key).digest('hex')}, ${u.id}) RETURNING id, name, scope, key_prefix, created_at`;
    await audit(sql, u, 'api_key.create', 'service_api_key', row.id as string, null, { name: b.name, scope: b.scope, prefix }, req.ip);
    reply.code(201);
    return { ...row, apiKey: key, note: 'Simpan sekarang — API key tidak dapat ditampilkan lagi' };
  });

  app.post('/api/v1/integrations/api-keys/:id/revoke', { ...auth, preValidation: A }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await sql`UPDATE service_api_keys SET revoked_at = now() WHERE id = ${id} AND tenant_id = ${req.authUser.tenantId} AND revoked_at IS NULL RETURNING id`;
    if (!row) throw notFound('API key aktif');
    await audit(sql, req.authUser, 'api_key.revoke', 'service_api_key', id, null, null, req.ip);
    return { id, revoked: true };
  });
}

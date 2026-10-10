import { z } from 'zod';
import type { Sql } from '../db.js';
import { config as appConfig } from '../config.js';
import { badRequest } from './errors.js';
import { decryptSecret, encryptSecret } from './secrets.js';

export const INTEGRATION_KINDS = ['ESIGN_VIDA', 'ESIGN_PRIVY', 'STORAGE_S3', 'TENDER_FEED'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** URL eksternal: wajib HTTPS; HTTP hanya untuk localhost di luar production (uji/dev). */
export function assertSafeUrl(raw: string, label: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest(`${label} bukan URL yang valid`); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  if (u.protocol === 'https:') return u.toString().replace(/\/$/, '');
  if (u.protocol === 'http:' && local && appConfig.nodeEnv !== 'production') return u.toString().replace(/\/$/, '');
  throw badRequest(`${label} wajib HTTPS`);
}

interface FieldMeta { key: string; label: string; type?: 'text' | 'number' | 'boolean' | 'select'; options?: string[]; placeholder?: string; required?: boolean }
export interface IntegrationDef {
  kind: IntegrationKind; label: string; description: string; status: 'READY' | 'CREDENTIALS_ONLY';
  configFields: FieldMeta[]; secretFields: FieldMeta[];
  config: z.ZodTypeAny; secrets: z.ZodTypeAny;
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    kind: 'ESIGN_VIDA', label: 'VIDA Sign (PSrE tersertifikasi)', status: 'READY',
    description: 'Tanda tangan digital tersertifikasi via VIDA VSP OpenAPI: OAuth2 client credentials, envelope, tautan tanda tangan, status, unduh dokumen bertanda tangan. Environment URL & kredensial diberikan VIDA per workspace.',
    configFields: [
      { key: 'baseUrl', label: 'Environment URL (dari VIDA)', placeholder: 'https://…', required: true },
      { key: 'creatorEmail', label: 'Email pembuat envelope (member workspace VIDA)', required: true },
      { key: 'signatureType', label: 'Jenis tanda tangan', type: 'select', options: ['DIGITAL', 'ESIGN'] },
      { key: 'expirationDays', label: 'Masa berlaku envelope (hari, 1–90)', type: 'number' },
    ],
    secretFields: [{ key: 'clientId', label: 'Client ID', required: true }, { key: 'clientSecret', label: 'Client Secret', required: true }],
    config: z.object({ baseUrl: z.string().min(8), creatorEmail: z.string().email(), signatureType: z.enum(['DIGITAL', 'ESIGN']).default('DIGITAL'), expirationDays: z.coerce.number().int().min(1).max(90).default(30) }),
    secrets: z.object({ clientId: z.string().min(3), clientSecret: z.string().min(6) }),
  },
  {
    kind: 'ESIGN_PRIVY', label: 'Privy (PSrE tersertifikasi)', status: 'CREDENTIALS_ONLY',
    description: 'Kredensial tersimpan terenkripsi. Spesifikasi API Privy hanya tersedia lewat console.privy.id setelah kerja sama; adapter diaktifkan setelah dokumen API resmi diterima. Sementara gunakan VIDA atau unggah kontrak bertanda tangan.',
    configFields: [
      { key: 'baseUrl', label: 'Base URL API (dari Privy)', placeholder: 'https://…', required: true },
      { key: 'enterpriseId', label: 'Enterprise / channel ID (dari Privy)' },
    ],
    secretFields: [{ key: 'clientId', label: 'Client ID / Merchant key', required: true }, { key: 'clientSecret', label: 'Client Secret', required: true }],
    config: z.object({ baseUrl: z.string().min(8), enterpriseId: z.string().max(120).optional() }),
    secrets: z.object({ clientId: z.string().min(3), clientSecret: z.string().min(6) }),
  },
  {
    kind: 'STORAGE_S3', label: 'Object storage (MinIO / S3)', status: 'READY',
    description: 'Replikasi semua dokumen (tender, Document Center, kontrak bertanda tangan) ke bucket S3-compatible terenkripsi. Disk lokal tetap dipakai sebagai cache kerja; file dibaca ulang dari bucket bila salinan lokal hilang.',
    configFields: [
      { key: 'endpoint', label: 'Endpoint (kosongkan untuk AWS S3)', placeholder: 'https://minio.internal:9000' },
      { key: 'region', label: 'Region', placeholder: 'ap-southeast-3', required: true },
      { key: 'bucket', label: 'Bucket', required: true },
      { key: 'prefix', label: 'Prefix objek (opsional)', placeholder: 'icop/' },
      { key: 'forcePathStyle', label: 'Path-style (wajib untuk MinIO)', type: 'boolean' },
    ],
    secretFields: [{ key: 'accessKeyId', label: 'Access key ID', required: true }, { key: 'secretAccessKey', label: 'Secret access key', required: true }],
    config: z.object({ endpoint: z.string().optional().default(''), region: z.string().min(2), bucket: z.string().min(3).max(63), prefix: z.string().max(60).optional().default(''), forcePathStyle: z.coerce.boolean().default(true) }),
    secrets: z.object({ accessKeyId: z.string().min(3), secretAccessKey: z.string().min(6) }),
  },
  {
    kind: 'TENDER_FEED', label: 'Feed tender (Cyber Tender Radar / sumber sah)', status: 'READY',
    description: 'Tarik daftar tender terjadwal dari endpoint JSON sumber sah (mis. ekspor Cyber Tender Radar) — format sama dengan impor manual {items:[…]}. Tidak melakukan scraping portal pengadaan.',
    configFields: [
      { key: 'url', label: 'URL feed JSON', placeholder: 'https://tip.defendit360.com/api/export', required: true },
      { key: 'minRelevance', label: 'Skor relevansi minimum (0–100)', type: 'number' },
      { key: 'intervalHours', label: 'Interval tarik (jam)', type: 'number' },
    ],
    secretFields: [{ key: 'apiKey', label: 'API key (header Authorization: Bearer)' }],
    config: z.object({ url: z.string().min(8), minRelevance: z.coerce.number().int().min(0).max(100).default(15), intervalHours: z.coerce.number().int().min(1).max(168).default(6) }),
    secrets: z.object({ apiKey: z.string().optional() }),
  },
];
export const integrationDef = (k: string) => INTEGRATIONS.find((d) => d.kind === k) ?? null;

export interface IntegrationRow<C = any, S = any> { enabled: boolean; config: C; secrets: S; lastRunAt: Date | null }

export async function getIntegration<C = any, S = any>(sql: Sql | any, tenantId: string, kind: IntegrationKind): Promise<IntegrationRow<C, S> | null> {
  const [r] = await sql`SELECT enabled, config, secret_enc, last_run_at FROM integration_credentials WHERE tenant_id = ${tenantId} AND kind = ${kind}`;
  if (!r) return null;
  return { enabled: r.enabled, config: r.config as C, secrets: (r.secretEnc ? JSON.parse(decryptSecret(r.secretEnc as string)) : {}) as S, lastRunAt: r.lastRunAt };
}

/** Simpan konfigurasi; rahasia digabung (field kosong = pertahankan nilai lama). Mengembalikan petunjuk masking. */
export async function saveIntegration(sql: Sql, tenantId: string, userId: string, kind: IntegrationKind, body: { enabled: boolean; config: Record<string, unknown>; secrets?: Record<string, string> }) {
  const def = integrationDef(kind)!;
  const cfg = def.config.parse(body.config) as Record<string, any>;
  if (cfg.baseUrl) cfg.baseUrl = assertSafeUrl(cfg.baseUrl, 'Base URL');
  if (cfg.url) cfg.url = assertSafeUrl(cfg.url, 'URL feed');
  if (cfg.endpoint) cfg.endpoint = assertSafeUrl(cfg.endpoint, 'Endpoint');
  const existing = await getIntegration(sql, tenantId, kind);
  const merged: Record<string, string> = { ...(existing?.secrets ?? {}) };
  for (const [k, v] of Object.entries(body.secrets ?? {})) if (typeof v === 'string' && v.length) merged[k] = v;
  const parsedSecrets = def.secrets.safeParse(merged);
  if (!parsedSecrets.success && body.enabled) throw badRequest('Kredensial wajib belum lengkap', parsedSecrets.error.flatten());
  const hint = Object.entries(merged).map(([k, v]) => `${k}:…${String(v).slice(-4)}`).join(', ') || null;
  const enc = Object.keys(merged).length ? encryptSecret(JSON.stringify(merged)) : null;
  await sql`INSERT INTO integration_credentials (tenant_id, kind, enabled, config, secret_enc, secret_hint, updated_by, updated_at)
    VALUES (${tenantId}, ${kind}, ${body.enabled}, ${sql.json(cfg as never)}, ${enc}, ${hint}, ${userId}, now())
    ON CONFLICT (tenant_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, secret_enc = EXCLUDED.secret_enc,
      secret_hint = EXCLUDED.secret_hint, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  return { config: cfg, secretHint: hint };
}

export async function recordTest(sql: Sql, tenantId: string, kind: IntegrationKind, ok: boolean, message: string) {
  await sql`UPDATE integration_credentials SET last_test_at = now(), last_test_ok = ${ok}, last_test_message = ${message.slice(0, 500)} WHERE tenant_id = ${tenantId} AND kind = ${kind}`;
}

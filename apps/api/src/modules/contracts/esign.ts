import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import type { Sql } from '../../db.js';
import { AppError } from '../../lib/errors.js';
import { getIntegration } from '../../lib/integrations.js';

/**
 * Abstraksi penyedia tanda tangan elektronik (PSrE).
 *  - 'vida'   : VIDA VSP OpenAPI (docs.vida.id): OAuth2 client credentials → create envelope (multipart) → start-signature
 *               (tautan tanda tangan per penanda tangan) → status (polling; VSP OpenAPI tidak menyediakan webhook) → unduh PDF bertanda tangan.
 *  - 'privy'  : kredensial dapat diregistrasi; adapter menunggu spesifikasi API resmi dari Privy (tidak publik).
 *  - 'sandbox': simulator UAT; TIDAK mengikat secara hukum dan diblokir di production.
 * Kontrak yang ditandatangani di luar sistem (tanda tangan basah/TTE lain) tetap dapat diunggah dan diverifikasi Legal.
 */
export interface EsignSigner { name: string; email: string; order: number }
export interface EsignEnvelope { providerRef: string; signingUrl: string | null; signingLinks: { email: string; url: string }[]; legallyBinding: boolean; status: string }
export type EsignState = 'PENDING' | 'COMPLETED' | 'DECLINED' | 'EXPIRED';
export interface EsignStatus { status: EsignState; providerStatus: string; recipients: { email: string; status: string }[]; expiresAt?: string | null }
export interface CreateArgs { contractNumber: string; title: string; documentSha256: string; pdf?: Buffer; filename?: string; pageCount?: number; signers: EsignSigner[] }
export interface EsignProvider {
  name: string;
  label: string;
  certified: boolean;
  needsDocument: boolean;
  createEnvelope(args: CreateArgs): Promise<EsignEnvelope>;
  getStatus?(providerRef: string): Promise<EsignStatus>;
  downloadSigned?(providerRef: string): Promise<Buffer>;
  verifyWebhook(rawBody: string, signatureHeader: string | undefined): boolean;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let esignFetch: FetchFn = (u, i) => fetch(u, i);
/** Dipakai test untuk menyuntikkan server tiruan sesuai spesifikasi penyedia. */
export function setEsignFetch(f?: FetchFn) { esignFetch = f ?? ((u, i) => fetch(u, i)); }

/* ───── Sandbox (UAT) ───── */
const sandboxSecret = () => process.env.ESIGN_SANDBOX_SECRET ?? `sandbox-${config.jwtSecret.slice(0, 16)}`;
export const sandboxProvider: EsignProvider = {
  name: 'sandbox', label: 'Sandbox UAT (tidak mengikat hukum)', certified: false, needsDocument: false,
  async createEnvelope() {
    return { providerRef: `SBX-${randomUUID()}`, signingUrl: null, signingLinks: [], legallyBinding: false, status: 'PENDING' };
  },
  verifyWebhook(raw, header) {
    if (!header) return false;
    const expected = createHmac('sha256', sandboxSecret()).update(raw).digest('hex');
    const got = header.replace(/^sha256=/, '');
    return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  },
};
export const signSandboxPayload = (raw: string) => `sha256=${createHmac('sha256', sandboxSecret()).update(raw).digest('hex')}`;
const sandboxAllowed = () => !(config.nodeEnv === 'production' || process.env.ESIGN_SANDBOX_ENABLED === 'false');

/* ───── VIDA VSP OpenAPI ───── */
interface VidaCfg { baseUrl: string; creatorEmail: string; signatureType?: 'DIGITAL' | 'ESIGN'; expirationDays?: number }
interface VidaSec { clientId: string; clientSecret: string }
const tokenCache = new Map<string, { token: string; exp: number }>();

async function vidaJson(res: Response, what: string) {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok || body?.success === false) {
    const code = body?.code ?? body?.error?.code ?? res.status;
    const msg = body?.message ?? body?.error?.message ?? text.slice(0, 200);
    throw new AppError(502, 'ESIGN_PROVIDER_ERROR', `VIDA ${what} gagal (${code}): ${msg}`);
  }
  return body;
}

export function vidaProvider(cfg: VidaCfg, sec: VidaSec): EsignProvider {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const token = async () => {
    const key = `${base}|${sec.clientId}`;
    const hit = tokenCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.token;
    const res = await esignFetch(`${base}/core/api/rest/v1/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: sec.clientId, client_secret: sec.clientSecret }).toString(),
    });
    const b = await vidaJson(res, 'autentikasi');
    if (!b?.access_token) throw new AppError(502, 'ESIGN_PROVIDER_ERROR', 'VIDA tidak mengembalikan access_token');
    // Token production berlaku ±5 menit — cache dengan margin 30 detik
    tokenCache.set(key, { token: b.access_token, exp: Date.now() + Math.max(30, Number(b.expires_in ?? 300) - 30) * 1000 });
    return b.access_token as string;
  };
  const auth = async () => ({ authorization: `Bearer ${await token()}` });
  return {
    name: 'vida', label: 'VIDA Sign', certified: true, needsDocument: true,
    async createEnvelope(a) {
      if (!a.pdf) throw new AppError(422, 'BUSINESS_RULE', 'Dokumen kontrak final (PDF) wajib diunggah sebelum dikirim ke VIDA');
      const page = Math.max(1, a.pageCount ?? 1);
      const details = {
        envelope_name: `${a.contractNumber} — ${a.title}`.slice(0, 255),
        sign_order_type: a.signers.length > 1 ? 'SERIAL' : 'PARALLEL',
        signature_type: cfg.signatureType ?? 'DIGITAL',
        remind_interval_day: 2,
        separate_document_sign: true,
        expiration_days: cfg.expirationDays ?? 30,
        recipients: a.signers.map((s) => ({ email: s.email, order: s.order, name: s.name })),
        // Kotak tanda tangan di halaman terakhir, berdampingan (koordinat VIDA dalam point PDF)
        fields: a.signers.map((s, i) => ({ type: 'Signature', x: 60 + i * 270, y: 90, height: 60, width: 160, page_index: page, recipient_email: s.email })),
      };
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(a.pdf)], { type: 'application/pdf' }), a.filename ?? `${a.contractNumber.replace(/\//g, '-')}.pdf`);
      form.append('creator_email', cfg.creatorEmail);
      form.append('envelope_details', JSON.stringify(details));
      const created = await vidaJson(await esignFetch(`${base}/core/external-api/rest/v1/envelope`, { method: 'POST', headers: await auth(), body: form }), 'membuat envelope');
      const envelopeId = created?.data?.id as string;
      if (!envelopeId) throw new AppError(502, 'ESIGN_PROVIDER_ERROR', 'VIDA tidak mengembalikan ID envelope');
      const started = await vidaJson(await esignFetch(`${base}/core/external-api/rest/v1/envelope/${envelopeId}/start-signature`, {
        method: 'POST', headers: { ...(await auth()), 'content-type': 'application/json' }, body: '{}' }), 'memulai tanda tangan');
      const links = ((started?.data?.signature_links ?? []) as { email: string; signature_link: string }[]).map((l) => ({ email: l.email, url: l.signature_link }));
      return { providerRef: envelopeId, signingUrl: links[0]?.url ?? null, signingLinks: links, legallyBinding: true, status: started?.data?.envelope_status ?? 'PENDING' };
    },
    async getStatus(ref) {
      const b = await vidaJson(await esignFetch(`${base}/core/external-api/rest/v1/envelope/${ref}/status`, { headers: { ...(await auth()), 'content-type': '*/*' } }), 'cek status');
      const ps = String(b?.data?.status ?? 'PENDING');
      const status: EsignState = ps === 'COMPLETED' ? 'COMPLETED' : ps === 'DECLINED' ? 'DECLINED' : ['RECALLED', 'DELETED'].includes(ps) ? 'EXPIRED' : 'PENDING';
      return { status, providerStatus: ps, recipients: ((b?.data?.recipients ?? []) as any[]).map((r) => ({ email: r.email, status: r.status })), expiresAt: b?.data?.expiry_at ?? null };
    },
    async downloadSigned(ref) {
      const res = await esignFetch(`${base}/document/external-api/rest/v1/envelope/${ref}/signed-document`, { headers: { ...(await auth()), 'content-type': '*/*' } });
      if (!res.ok) await vidaJson(res, 'unduh dokumen bertanda tangan');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 4).toString() !== '%PDF') throw new AppError(502, 'ESIGN_PROVIDER_ERROR', 'Dokumen bertanda tangan dari VIDA bukan PDF tunggal');
      return buf;
    },
    verifyWebhook: () => false, // VSP OpenAPI: status lewat polling
  };
}

/** Uji kredensial VIDA: meminta access token baru (tanpa membuat envelope). */
export async function testVida(cfg: VidaCfg, sec: VidaSec) {
  const base = cfg.baseUrl.replace(/\/$/, '');
  tokenCache.delete(`${base}|${sec.clientId}`);
  const res = await esignFetch(`${base}/core/api/rest/v1/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: sec.clientId, client_secret: sec.clientSecret }).toString(),
  });
  const b = await vidaJson(res, 'autentikasi');
  return { ok: !!b?.access_token, expiresIn: b?.expires_in ?? null };
}

/* ───── Privy: kredensial saja ───── */
const privyPending: EsignProvider = {
  name: 'privy', label: 'Privy', certified: true, needsDocument: true,
  async createEnvelope() {
    throw new AppError(501, 'ESIGN_ADAPTER_PENDING', 'Kredensial Privy tersimpan, tetapi spesifikasi API Privy belum diterima (hanya tersedia via console.privy.id setelah kerja sama). Gunakan VIDA atau unggah kontrak bertanda tangan.');
  },
  verifyWebhook: () => false,
};

/** Penyedia untuk webhook (tanpa konteks tenant): hanya sandbox yang memakai webhook. */
export function getProvider(name: string): EsignProvider | null {
  return name === 'sandbox' && sandboxAllowed() ? sandboxProvider : null;
}

export async function resolveProvider(sql: Sql | any, tenantId: string, name: string): Promise<EsignProvider | null> {
  if (name === 'sandbox') return getProvider('sandbox');
  if (name === 'vida') {
    const it = await getIntegration<VidaCfg, VidaSec>(sql, tenantId, 'ESIGN_VIDA');
    return it?.enabled && it.secrets.clientId ? vidaProvider(it.config, it.secrets) : null;
  }
  if (name === 'privy') {
    const it = await getIntegration(sql, tenantId, 'ESIGN_PRIVY');
    return it?.enabled ? privyPending : null;
  }
  return null;
}

export async function availableProviders(sql: Sql | any, tenantId: string) {
  const vida = await getIntegration(sql, tenantId, 'ESIGN_VIDA');
  const privy = await getIntegration(sql, tenantId, 'ESIGN_PRIVY');
  return [
    { name: 'vida', certified: true, enabled: !!(vida?.enabled && vida.secrets.clientId), needsDocument: true,
      note: vida?.enabled ? 'VIDA Sign — tanda tangan digital tersertifikasi (butuh PDF kontrak final)' : 'Belum dikonfigurasi admin (Pengaturan → Integrasi)' },
    { name: 'privy', certified: true, enabled: false, needsDocument: true,
      note: privy?.enabled ? 'Kredensial tersimpan — adapter menunggu spesifikasi API resmi Privy' : 'Belum dikonfigurasi admin (Pengaturan → Integrasi)' },
    { name: 'sandbox', certified: false, enabled: sandboxAllowed(), needsDocument: false, note: 'Simulator UAT — tidak mengikat secara hukum' },
  ];
}

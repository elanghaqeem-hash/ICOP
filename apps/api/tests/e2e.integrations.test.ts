/**
 * Phase 2b — menu Integrasi admin: e-sign VIDA (server tiruan sesuai VSP OpenAPI docs.vida.id), Privy (kredensial saja),
 * object storage S3/MinIO (server S3 nyata: moto), feed tender, API key layanan. Rahasia tidak pernah dikembalikan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import nodemailer from 'nodemailer';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { pollEsignSignatures } from '../src/modules/contracts/routes.js';
import { api, freshDb, login } from './helpers.js';
import { makeRksPdf, multipart } from './fixtures/rks.js';

let sql: Sql;
let app: FastifyInstance;
const T: Record<string, string> = {};
const ctx: Record<string, any> = {};

/* ───── Server VIDA tiruan (kontrak API sesuai dokumentasi resmi VSP OpenAPI) ───── */
const VIDA = 'https://vida.test';
const vida = { envelopes: new Map<string, { status: string; details: any; fileBytes: number }>(), calls: [] as string[], lastForm: null as FormData | null };
let signedPdf: Buffer;
async function outbound(url: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.origin === VIDA) {
    vida.calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.pathname === '/core/api/rest/v1/oauth2/token') {
      const form = new URLSearchParams(String(init.body));
      if (form.get('grant_type') !== 'client_credentials') return json(400, { success: false, message: 'invalid grant' });
      if (form.get('client_id') !== 'vida-client' || form.get('client_secret') !== 'vida-secret-123') return json(401, { success: false, code: 'AU.401', message: 'Bad credentials' });
      return json(200, { access_token: 'tok-1', token_type: 'bearer', expires_in: 299, scope: 'read write' });
    }
    if (!String((init.headers as Record<string, string>)?.authorization ?? '').startsWith('Bearer tok-1')) return json(401, { success: false, message: 'unauthorized' });
    if (u.pathname === '/core/external-api/rest/v1/envelope' && init.method === 'POST') {
      const form = init.body as FormData;
      vida.lastForm = form;
      const file = form.get('file') as Blob;
      const details = JSON.parse(String(form.get('envelope_details')));
      if (form.get('creator_email') !== 'legal@defendit360.com') return json(400, { success: false, code: 'MG.20707', message: 'The creator_email is not a member of the current workspace.' });
      const id = `env-${vida.envelopes.size + 1}`;
      vida.envelopes.set(id, { status: 'DRAFT', details, fileBytes: file.size });
      return json(200, { success: true, data: { id } });
    }
    const m = u.pathname.match(/\/envelope\/([^/]+)\/(start-signature|status|signed-document)$/);
    if (m) {
      const env = vida.envelopes.get(m[1]);
      if (!env) return json(400, { success: false, code: 'ES.10501', message: 'Envelope not found.' });
      if (m[2] === 'start-signature') {
        env.status = 'PENDING';
        return json(200, { success: true, data: { envelope_id: m[1], envelope_status: 'PENDING',
          signature_links: env.details.recipients.map((r: any) => ({ email: r.email, signature_link: `https://sign.vida.id/signEnvelope/${m[1]}-${r.order}` })) } });
      }
      if (m[2] === 'status') return json(200, { success: true, data: { status: env.status, recipients: env.details.recipients.map((r: any) => ({ ...r, status: env.status === 'COMPLETED' ? 'SIGNED' : 'PENDING', is_signer: true })), expiry_at: null } });
      if (env.status !== 'COMPLETED') return json(400, { success: false, code: 'ER.10114', message: 'Unable to execute, the envelope is not in signature completion state.' });
      return new Response(new Uint8Array(signedPdf), { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    return json(404, { success: false, message: 'not found' });
  }
  if (u.origin === 'https://feed.test') {
    if ((init.headers as Record<string, string>)?.authorization !== 'Bearer feed-key-1') return json(401, { error: 'unauthorized' });
    return json(200, { items: [
      { title: 'Jasa Penetration Test Aplikasi Mobile Banking', procuringEntity: 'Bank Daerah Demo', source: 'tender_radar', sourceRef: 'TIP-001', serviceCategory: 'VAPT', hpsValue: 450000000 },
      { title: 'x', procuringEntity: '' },
    ] });
  }
  return json(599, { error: `unexpected outbound ${url}` });
}

/* ───── moto S3 server (nyata) ───── */
let moto: ChildProcess | null = null;
const MOTO_PORT = 5055;
const portOpen = (port: number) => new Promise<boolean>((res) => { const s = createConnection(port, '127.0.0.1'); s.on('connect', () => { s.end(); res(true); }); s.on('error', () => res(false)); });
async function startMoto() {
  try {
    moto = spawn('moto_server', ['-H', '127.0.0.1', '-p', String(MOTO_PORT)], { stdio: 'ignore' });
    for (let i = 0; i < 40; i++) { if (await portOpen(MOTO_PORT)) return true; await new Promise((r) => setTimeout(r, 250)); }
  } catch { /* moto tidak tersedia */ }
  return false;
}
let s3Ready = false;

async function contractToSignature(title: string, withFinalPdf: boolean) {
  const salesId = (await api(app, T.sales).get('/api/v1/auth/me')).body.id;
  const [c] = await sql`INSERT INTO contracts (tenant_id, number, customer_id, contract_type, title, value, tax_rate, start_date, end_date, payment_terms, status, legal_checklist, created_by)
    VALUES (${ctx.tenantId}, ${`9${Math.floor(Math.random() * 90 + 10)}/DEIT-PKS/X/2026`}, ${ctx.customerId}, 'PROJECT', ${title}, 120000000, 11, '2026-11-01', '2027-10-31',
            '30% DP, 70% BAST', 'DRAFT', ${sql.json({})}, ${salesId}) RETURNING id`;
  if (withFinalPdf) {
    const mp = multipart({}, { name: 'file', filename: 'pks-final.pdf', content: await makeRksPdf(), type: 'application/pdf' });
    const r = await app.inject({ method: 'POST', url: `/api/v1/contracts/${c.id}/final-document`, payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${T.sales}` } });
    expect(r.statusCode, r.body).toBe(201);
    ctx.finalPages = r.json().pages;
  }
  expect((await api(app, T.sales).post(`/api/v1/contracts/${c.id}/submit-legal`)).status).toBe(200);
  const det = await api(app, T.sales).get(`/api/v1/contracts/${c.id}`);
  const checklist = Object.fromEntries(det.body.legalChecklistKeys.map((k: string) => [k, true]));
  const lr = await api(app, T.legal).post(`/api/v1/contracts/${c.id}/legal-review`, { checklist, decision: 'APPROVE' });
  expect(lr.status, JSON.stringify(lr.body)).toBe(200);
  for (const st of lr.body.steps) {
    const who = st.level === 1 ? T.mgr : st.level === 2 ? T.vp : T.dir;
    expect((await api(app, who).post(`/api/v1/approvals/${lr.body.approvalRequestId}/decide`, { decision: 'APPROVE' })).status).toBe(200);
  }
  return c.id as string;
}

beforeAll(async () => {
  sql = await freshDb();
  process.env.DOCUMENT_DIR = '/tmp/icop-int-docs';
  await rm('/tmp/icop-int-docs', { recursive: true, force: true });
  signedPdf = await makeRksPdf([['PERJANJIAN KERJA SAMA — DITANDATANGANI SECARA ELEKTRONIK (VIDA)']]);
  app = await buildApp({ sql, logger: false, mailTransport: nodemailer.createTransport({ jsonTransport: true }), outboundFetch: outbound });
  const users = { admin: 'companyadmin@defendit360.com', sales: 'sales@defendit360.com', legal: 'legal@defendit360.com', mgr: 'salesmanager@defendit360.com',
    vp: 'vp@defendit360.com', dir: 'direktur@defendit360.com', tender: 'tender@defendit360.com' };
  for (const [k, e] of Object.entries(users)) T[k] = await login(app, e);
  const [tn] = await sql`SELECT id FROM tenants WHERE code = 'DEIT'`;
  ctx.tenantId = tn.id;
  ctx.customerId = (await api(app, T.sales).post('/api/v1/customers', { legalName: 'PT Integrasi Demo', industry: 'banking', clientTier: 'A' })).body.id;
  s3Ready = await startMoto();
  if (s3Ready) {
    const c = new S3Client({ region: 'us-east-1', endpoint: `http://127.0.0.1:${MOTO_PORT}`, forcePathStyle: true, credentials: { accessKeyId: 'minio-key', secretAccessKey: 'minio-secret' } });
    await c.send(new CreateBucketCommand({ Bucket: 'icop-docs' }));
  }
}, 90_000);
afterAll(async () => { moto?.kill(); await app.close(); await sql.end(); });

describe('Menu Integrasi: akses & kerahasiaan', () => {
  it('hanya Company Admin; rahasia tidak pernah dikembalikan', async () => {
    expect((await api(app, T.sales).get('/api/v1/integrations')).status).toBe(403);
    expect((await api(app, T.legal).put('/api/v1/integrations/ESIGN_VIDA', { enabled: true, config: {}, secrets: {} })).status).toBe(403);
    const r = await api(app, T.admin).put('/api/v1/integrations/ESIGN_VIDA', { enabled: true,
      config: { baseUrl: VIDA, creatorEmail: 'legal@defendit360.com', signatureType: 'DIGITAL', expirationDays: 30 }, secrets: { clientId: 'vida-client', clientSecret: 'vida-secret-123' } });
    expect(r.status).toBe(200);
    const list = await api(app, T.admin).get('/api/v1/integrations');
    expect(JSON.stringify(list.body)).not.toContain('vida-secret-123');
    const v = list.body.items.find((x: any) => x.kind === 'ESIGN_VIDA');
    expect(v.enabled).toBe(true);
    expect(v.secretHint).toContain('…-123');
    const [row] = await sql`SELECT secret_enc FROM integration_credentials WHERE kind = 'ESIGN_VIDA'`;
    expect(row.secretEnc).toMatch(/^v1:/);
  });

  it('URL non-HTTPS ditolak (kecuali localhost di non-production); kredensial wajib saat diaktifkan', async () => {
    expect((await api(app, T.admin).put('/api/v1/integrations/TENDER_FEED', { enabled: true, config: { url: 'http://feed.example.com/x' } })).status).toBe(400);
    expect((await api(app, T.admin).put('/api/v1/integrations/STORAGE_S3', { enabled: true, config: { region: 'x', bucket: 'icop-docs' } })).status).toBe(400);
  });

  it('uji koneksi VIDA memakai OAuth2 client credentials; secret salah tercatat gagal', async () => {
    const ok = await api(app, T.admin).post('/api/v1/integrations/ESIGN_VIDA/test');
    expect(ok.body).toMatchObject({ ok: true });
    await api(app, T.admin).put('/api/v1/integrations/ESIGN_VIDA', { enabled: true, config: { baseUrl: VIDA, creatorEmail: 'legal@defendit360.com' }, secrets: { clientSecret: 'wrong-secret' } });
    const bad = await api(app, T.admin).post('/api/v1/integrations/ESIGN_VIDA/test');
    expect(bad.body.ok).toBe(false);
    expect(bad.body.message).toMatch(/AU\.401|Bad credentials/);
    await api(app, T.admin).put('/api/v1/integrations/ESIGN_VIDA', { enabled: true, config: { baseUrl: VIDA, creatorEmail: 'legal@defendit360.com' }, secrets: { clientSecret: 'vida-secret-123' } });
  });
});

describe('E-sign VIDA (tersertifikasi) & Privy', () => {
  it('tanpa PDF kontrak final → VIDA ditolak; PDF final hanya boleh diganti sebelum approval', async () => {
    const id = await contractToSignature('Kontrak tanpa PDF final', false);
    const r = await api(app, T.sales).post(`/api/v1/contracts/${id}/signatures/customer/esign`, { provider: 'vida', signerName: 'Ibu Direktur', signerEmail: 'dir@customer.co.id' });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/PDF kontrak final/);
    const mp = multipart({}, { name: 'file', filename: 'late.pdf', content: await makeRksPdf(), type: 'application/pdf' });
    const late = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/final-document`, payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${T.sales}` } });
    expect(late.statusCode).toBe(422);
  });

  it('kirim ke VIDA: envelope serial (customer → penanda tangan internal), kotak tanda tangan di halaman terakhir, tautan tanda tangan', async () => {
    const id = await contractToSignature('Kontrak VIDA', true);
    ctx.vidaContract = id;
    const det = await api(app, T.sales).get(`/api/v1/contracts/${id}`);
    expect(det.body.esignProviders.find((p: any) => p.name === 'vida').enabled).toBe(true);
    expect(det.body.finalDocument.pageCount ?? ctx.finalPages).toBeGreaterThan(0);
    const r = await api(app, T.sales).post(`/api/v1/contracts/${id}/signatures/customer/esign`, { provider: 'vida', signerName: 'Ibu Direktur Bank', signerEmail: 'dir@customer.co.id',
      signerTitle: 'Direktur', internalSigner: { name: 'Direktur Utama DEIT', email: 'direktur@defendit360.com' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.legallyBinding).toBe(true);
    expect(r.body.signingLinks.map((l: any) => l.email)).toEqual(['dir@customer.co.id', 'direktur@defendit360.com']);
    ctx.vidaSig = r.body.id;
    const env = vida.envelopes.get(r.body.providerRef)!;
    expect(env.details.sign_order_type).toBe('SERIAL');
    expect(env.details.recipients).toEqual([{ email: 'dir@customer.co.id', order: 1, name: 'Ibu Direktur Bank' }, { email: 'direktur@defendit360.com', order: 2, name: 'Direktur Utama DEIT' }]);
    expect(env.details.fields.every((f: any) => f.type === 'Signature' && f.page_index === ctx.finalPages)).toBe(true);
    expect(env.fileBytes).toBeGreaterThan(500);
    expect(vida.lastForm!.get('creator_email')).toBe('legal@defendit360.com');
    expect((await api(app, T.sales).post(`/api/v1/contracts/${id}/signatures/customer/esign`, { provider: 'vida', signerName: 'X Y', signerEmail: 'x@y.co.id' })).status).toBe(409);
  });

  it('status ditarik (polling): PENDING → COMPLETED → PDF bertanda tangan disimpan, tanda tangan VERIFIED oleh PSrE; kontrak dapat diaktifkan', async () => {
    const id = ctx.vidaContract;
    const p1 = await api(app, T.sales).post(`/api/v1/contracts/${id}/signatures/${ctx.vidaSig}/refresh`);
    expect(p1.body).toMatchObject({ status: 'PENDING', providerStatus: 'PENDING', changed: false });
    for (const env of vida.envelopes.values()) env.status = 'COMPLETED';
    const polled = await pollEsignSignatures(sql);
    expect(polled.changed).toBe(1);
    const det = await api(app, T.sales).get(`/api/v1/contracts/${id}`);
    const sig = det.body.signatures.find((s: any) => s.id === ctx.vidaSig);
    expect(sig.status).toBe('VERIFIED');
    expect(sig.documentId).toBeTruthy();
    expect(sig.evidence.verifiedBy).toMatch(/VIDA/);
    const [doc] = await sql`SELECT filename, sha256 FROM documents WHERE id = ${sig.documentId}`;
    expect(doc.filename).toMatch(/-signed\.pdf$/);
    expect((await api(app, T.dir).post(`/api/v1/contracts/${id}/signatures/internal`, { signerTitle: 'Direktur Utama', confirm: true })).status).toBe(200);
    const act = await api(app, T.sales).post(`/api/v1/contracts/${id}/activate`, {}, { 'idempotency-key': 'act-vida' });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(act.body.status).toBe('ACTIVE');
  });

  it('Privy: kredensial tersimpan, pengiriman ditolak jujur (spesifikasi API belum tersedia)', async () => {
    expect((await api(app, T.admin).put('/api/v1/integrations/ESIGN_PRIVY', { enabled: true, config: { baseUrl: 'https://api.privy.test' }, secrets: { clientId: 'privy-merchant', clientSecret: 'privy-secret-99' } })).status).toBe(200);
    const id = await contractToSignature('Kontrak Privy', true);
    const r = await api(app, T.sales).post(`/api/v1/contracts/${id}/signatures/customer/esign`, { provider: 'privy', signerName: 'Bpk Komisaris', signerEmail: 'kom@customer.co.id' });
    expect(r.status).toBe(501);
    expect(r.body.code).toBe('ESIGN_ADAPTER_PENDING');
    // Jalur manual tetap tersedia
    const mp = multipart({ signerName: 'Bpk Komisaris' }, { name: 'file', filename: 'ttd.pdf', content: await makeRksPdf([['PKS bertanda tangan basah']]), type: 'application/pdf' });
    const up = await app.inject({ method: 'POST', url: `/api/v1/contracts/${id}/signatures/customer/upload`, payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${T.sales}` } });
    expect(up.statusCode).toBe(201);
  });
});

describe('Object storage S3/MinIO (server S3 nyata)', () => {
  it('uji koneksi, replikasi saat unggah, baca ulang dari bucket bila file lokal hilang, sinkronisasi', async (t) => {
    if (!s3Ready) t.skip();
    expect((await api(app, T.admin).put('/api/v1/integrations/STORAGE_S3', { enabled: true,
      config: { endpoint: `http://127.0.0.1:${MOTO_PORT}`, region: 'us-east-1', bucket: 'icop-docs', prefix: 'icop/', forcePathStyle: true },
      secrets: { accessKeyId: 'minio-key', secretAccessKey: 'minio-secret' } })).status).toBe(200);
    const test = await api(app, T.admin).post('/api/v1/integrations/STORAGE_S3/test');
    expect(test.body, JSON.stringify(test.body)).toMatchObject({ ok: true });
    const content = Buffer.from('Catatan rapat kickoff proyek — kerahasiaan internal.\n'.repeat(20));
    const mp = multipart({ title: 'Notulen kickoff', confidentiality: 'INTERNAL', compress: 'none', ocr: 'off' }, { name: 'file', filename: 'notulen.txt', content, type: 'text/plain' });
    const up = await app.inject({ method: 'POST', url: '/api/v1/documents', payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${T.sales}` } });
    expect(up.statusCode, up.body).toBe(202);
    const docId = up.json().id;
    const [d] = await sql`SELECT original_path FROM documents WHERE id = ${docId}`;
    const [obj] = await sql`SELECT object_key FROM storage_objects WHERE object_key LIKE ${'icop/%'} AND object_key LIKE ${'%' + d.originalPath.split('/').pop()}`;
    expect(obj.objectKey).toMatch(/^icop\/[0-9a-f-]+\/documents\//);
    await rm(d.originalPath as string);
    const dl = await app.inject({ method: 'GET', url: `/api/v1/documents/${docId}/file?variant=original`, headers: { authorization: `Bearer ${T.sales}` } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(content)).toBe(true);
    const sync = await api(app, T.admin).post('/api/v1/integrations/STORAGE_S3/sync');
    expect(sync.body.enabled).toBe(true);
    expect(sync.body.uploaded + sync.body.skipped).toBeGreaterThan(0);
  });
});

describe('Feed tender & API key layanan', () => {
  it('feed tender: item valid diimpor, item tidak valid dihitung, tarik ulang = duplikat', async () => {
    expect((await api(app, T.admin).put('/api/v1/integrations/TENDER_FEED', { enabled: true, config: { url: 'https://feed.test/export', minRelevance: 10, intervalHours: 6 }, secrets: { apiKey: 'feed-key-1' } })).status).toBe(200);
    const r1 = await api(app, T.admin).post('/api/v1/integrations/TENDER_FEED/run');
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ received: 2, invalid: 1 });
    expect(r1.body.created.length).toBe(1);
    const r2 = await api(app, T.admin).post('/api/v1/integrations/TENDER_FEED/run');
    expect(r2.body.duplicates.length).toBe(1);
  });

  it('API key layanan ditampilkan sekali, disimpan sebagai hash, dapat dicabut', async () => {
    const k = await api(app, T.admin).post('/api/v1/integrations/api-keys', { name: 'SOC SIEM Rapid7', scope: 'INGEST_SOC', customerId: ctx.customerId });
    expect(k.status).toBe(201);
    expect(k.body.apiKey).toMatch(/^icop_[0-9a-f]{8}_/);
    ctx.apiKey = k.body.apiKey; ctx.apiKeyId = k.body.id;
    const list = await api(app, T.admin).get('/api/v1/integrations/api-keys');
    expect(JSON.stringify(list.body)).not.toContain(k.body.apiKey);
    const [row] = await sql`SELECT key_hash FROM service_api_keys WHERE id = ${k.body.id}`;
    expect(row.keyHash).toHaveLength(64);
    expect((await api(app, T.admin).post(`/api/v1/integrations/api-keys/${k.body.id}/revoke`)).status).toBe(200);
    expect((await api(app, T.admin).post(`/api/v1/integrations/api-keys/${k.body.id}/revoke`)).status).toBe(404);
  });
});

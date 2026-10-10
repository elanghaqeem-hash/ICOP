/**
 * Phase 2b + Phase 3 acceptance — AI key registry & aktivasi fitur, Document Center (OCR nyata, kompresi, batas
 * 300 halaman/50 MB, analisis AI terverifikasi), FlexGuard wallet & service request, contract lifecycle, e-sign, handover.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { resetBreakers } from '../src/modules/ai/gateway.js';
import { runJobsOnce } from '../src/lib/jobs.js';
import { expireWallets } from '../src/modules/flexguard/routes.js';
import { signSandboxPayload } from '../src/modules/contracts/esign.js';
import { SEED_PW, api, freshDb, login, makeApp } from './helpers.js';
import { makeBlankPdf, makeImageOnlyPdf, makeRksPdf, multipart } from './fixtures/rks.js';

let sql: Sql;
let app: FastifyInstance;
const aiQueue: string[] = [];
const authHeaders: string[] = [];
const fakeFetch = async (url: string, init: RequestInit) => {
  const h = init.headers as Record<string, string>;
  authHeaders.push(h.authorization ?? h['x-api-key'] ?? h['x-goog-api-key'] ?? '');
  const text = aiQueue.shift();
  if (text === undefined) return new Response('{"error":"no mock"}', { status: 500 });
  if (url.includes('anthropic')) return Response.json({ content: [{ type: 'text', text }] });
  return Response.json({ choices: [{ message: { content: text } }] });
};
const T: Record<string, string> = {};
const ctx: Record<string, any> = {};
const upload = async (token: string, url: string, fields: Record<string, string>, content: Buffer, filename: string, type = 'application/pdf') => {
  const mp = multipart(fields, { name: 'file', filename, content, type });
  const r = await app.inject({ method: 'POST', url, payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${token}` } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};

beforeAll(async () => {
  sql = await freshDb();
  app = await makeApp(sql, fakeFetch as never);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];
  process.env.UPLOAD_DIR = '/tmp/icop-test-uploads';
  const users = { admin: 'companyadmin@defendit360.com', sales: 'sales@defendit360.com', presales: 'presales@defendit360.com', mgr: 'salesmanager@defendit360.com',
    vp: 'vp@defendit360.com', dir: 'direktur@defendit360.com', legal: 'legal@defendit360.com', pm: 'pm@defendit360.com', aud: 'auditor@defendit360.com', fin: 'finance@defendit360.com' };
  for (const [k, e] of Object.entries(users)) T[k] = await login(app, e);
  const c = await api(app, T.sales).post('/api/v1/customers', { legalName: 'PT Bank Wallet Demo', industry: 'banking', clientTier: 'A' });
  ctx.customer = c.body;
  const [tn] = await sql`SELECT id FROM tenants WHERE code = 'DEIT'`;
  await sql`INSERT INTO users (tenant_id, email, full_name, password_hash, role, customer_id, force_password_change)
            VALUES (${tn.id}, 'pic@wallet.co.id', 'PIC Wallet', ${await bcrypt.hash(SEED_PW, 4)}, 'customer_user', ${c.body.id}, false)`;
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'pic@wallet.co.id', password: SEED_PW } });
  T.cust = r.json().token;
});
afterAll(async () => { await app.close(); await sql.end(); });

describe('AI key registry, failover order & feature activation', () => {
  it('admin registers an encrypted key; it is never returned or logged in clear text', async () => {
    const a = api(app, T.admin);
    expect((await api(app, T.sales).put('/api/v1/ai/providers/openai/key', { apiKey: 'sk-test-ABCDEFGH12345678' })).status).toBe(403);
    expect((await a.put('/api/v1/ai/providers/openai/key', { apiKey: 'short' })).status).toBe(400);
    const r = await a.put('/api/v1/ai/providers/openai/key', { apiKey: 'sk-test-ABCDEFGH12345678' });
    expect(r.status).toBe(200);
    expect(r.body.keyMasked).toBe('…5678');
    const list = await a.get('/api/v1/ai/providers');
    const openai = list.body.items.find((p: any) => p.provider === 'openai');
    expect(openai.keySource).toBe('database');
    expect(openai.ready).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain('ABCDEFGH12345678');
    const [row] = await sql`SELECT api_key_enc FROM ai_providers WHERE provider = 'openai'`;
    expect(row.apiKeyEnc).toMatch(/^v1:/);
    expect(row.apiKeyEnc).not.toContain('ABCDEFGH');
    const [aud] = await sql`SELECT after FROM audit_events WHERE action = 'ai.key_registered' ORDER BY id DESC LIMIT 1`;
    expect(JSON.stringify(aud.after)).not.toContain('ABCDEFGH12345678');
  });

  it('failover order is configurable and the DB key is used for the provider call', async () => {
    const a = api(app, T.admin);
    await a.put('/api/v1/ai/providers/anthropic/key', { apiKey: 'sk-ant-test-ZZZZ99998888' });
    const o = await a.put('/api/v1/ai/providers/order', { order: ['openai', 'anthropic'] });
    expect(o.body.order.slice(0, 2)).toEqual(['openai', 'anthropic']);
    resetBreakers();
    authHeaders.length = 0;
    aiQueue.push('jawaban dari openai');
    const r = await api(app, T.sales).post('/api/v1/ai/complete', { feature: 'chat', prompt: 'halo' });
    expect(r.body.provider).toBe('openai');
    expect(authHeaders[0]).toBe('Bearer sk-test-ABCDEFGH12345678');
    // OpenAI gagal → failover ke Anthropic dengan key DB miliknya
    authHeaders.length = 0;
    const r2 = await api(app, T.sales).post('/api/v1/ai/complete', { feature: 'chat', prompt: 'halo' }); // tanpa mock → 500 semua
    expect(r2.status).toBe(503);
    expect(authHeaders).toEqual(['Bearer sk-test-ABCDEFGH12345678', 'sk-ant-test-ZZZZ99998888']);
  });

  it('per-feature and global activation is enforced server-side', async () => {
    const a = api(app, T.admin);
    expect((await a.put('/api/v1/ai/features', { features: { opportunity_brief: false } })).status).toBe(200);
    const f = await api(app, T.sales).get('/api/v1/ai/features');
    expect(f.body.items.find((x: any) => x.feature === 'opportunity_brief').effective).toBe(false);
    const r = await api(app, T.sales).post('/api/v1/ai/complete', { feature: 'opportunity_brief', prompt: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('AI_DISABLED');
    await a.put('/api/v1/ai/features', { features: { global: false } });
    expect((await api(app, T.sales).post('/api/v1/ai/complete', { feature: 'chat', prompt: 'x' })).status).toBe(409);
    expect((await a.put('/api/v1/ai/features', { features: { bogus: true } })).status).toBe(400);
    await a.put('/api/v1/ai/features', { features: { global: true, opportunity_brief: true } });
    const del = await a.delete('/api/v1/ai/providers/anthropic/key');
    expect(del.status).toBe(200);
  });
});

describe('Document Center — OCR, compression, limits, AI analysis', () => {
  it('rejects > 300 pages, > 50 MB, unknown types and duplicates', async () => {
    const big = await upload(T.presales, '/api/v1/documents', {}, await makeBlankPdf(301), 'big.pdf');
    expect(big.status).toBe(422);
    expect(big.body.details.pageCount).toBe(301);
    const huge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(51 * 1024 * 1024, 0x20)]);
    expect((await upload(T.presales, '/api/v1/documents', {}, huge, 'huge.pdf')).status).toBe(413);
    expect((await upload(T.presales, '/api/v1/documents', {}, Buffer.from('MZ binary'), 'x.exe', 'application/octet-stream')).status).toBe(400);
    const ok = await upload(T.presales, '/api/v1/documents', { ocr: 'off', compress: 'none' }, await makeBlankPdf(300), 'max.pdf');
    expect(ok.status).toBe(202);
    expect((await upload(T.presales, '/api/v1/documents', {}, await makeBlankPdf(300), 'max-copy.pdf')).status).toBe(409);
  });

  it('OCRs an image-only (scanned) PDF and records compression', { timeout: 120_000 }, async () => {
    const scan = await makeImageOnlyPdf();
    const up = await upload(T.presales, '/api/v1/documents', { title: 'RKS hasil scan', entityType: 'customer', entityId: ctx.customer.id, compress: 'aggressive' }, scan, 'rks-scan.pdf');
    expect(up.status).toBe(202);
    await runJobsOnce(sql, 10);
    const d = await api(app, T.presales).get(`/api/v1/documents/${up.body.id}`);
    expect(d.body.document.status).toBe('READY');
    expect(d.body.document.textSource).toBe('OCR');
    expect(d.body.document.ocrPages).toBe(2);
    expect(d.body.document.compression.before).toBe(scan.length);
    expect(d.body.document.compression.after).toBeLessThanOrEqual(scan.length);
    const p1 = await api(app, T.presales).get(`/api/v1/documents/${up.body.id}/pages/1`);
    expect(p1.body.source).toBe('OCR');
    expect(p1.body.text).toMatch(/NPWP/i);
    expect(p1.body.text).toMatch(/Jaminan Penawaran/i);
    ctx.scanDoc = up.body.id;
    const search = await api(app, T.sales).get('/api/v1/documents?q=Jaminan');
    expect(search.body.items.map((x: any) => x.id)).toContain(up.body.id);
  });

  it('native PDF keeps native text; scanned tender RKS is OCR-ed automatically', { timeout: 120_000 }, async () => {
    const up = await upload(T.presales, '/api/v1/documents', { title: 'RKS native' }, await makeRksPdf(), 'rks.pdf');
    await runJobsOnce(sql, 5);
    const d = await api(app, T.presales).get(`/api/v1/documents/${up.body.id}`);
    expect(d.body.document.textSource).toBe('NATIVE');
    expect(d.body.document.ocrPages).toBe(0);
    ctx.nativeDoc = up.body.id;
    // Tender: PDF scan → OCR_QUEUED → DONE → ekstraksi persyaratan berhasil
    const t = await api(app, T.presales).post('/api/v1/tenders', { title: 'Jasa SOC dan Pentest berbasis scan', procuringEntity: 'Dinas Demo', customerId: ctx.customer.id });
    const td = await upload(T.presales, `/api/v1/tenders/${t.body.id}/documents`, { kind: 'RKS' }, await makeImageOnlyPdf(), 'rks-scan.pdf');
    expect(td.body.extractionStatus).toBe('OCR_QUEUED');
    await runJobsOnce(sql, 5);
    const [row] = await sql`SELECT extraction_status, text_source FROM tender_documents WHERE id = ${td.body.id}`;
    expect(row.extractionStatus).toBe('DONE');
    const ex = await api(app, T.presales).post(`/api/v1/tenders/${t.body.id}/documents/${td.body.id}/extract`, { useAi: false });
    expect(ex.status).toBe(200);
    expect(ex.body.added).toBeGreaterThanOrEqual(8);
  });

  it('AI analyses are grounded: unverifiable quotes rejected, citations verified', async () => {
    const id = ctx.nativeDoc;
    resetBreakers();
    await api(app, T.admin).put('/api/v1/ai/providers/order', { order: ['openai'] });
    // SUMMARY (2 halaman → 1 chunk → 1 panggilan)
    aiQueue.push('Ringkasan: dokumen mensyaratkan NIB/NPWP [Hal. 1] dan SOC 24x7 [Hal. 2]. Rujukan palsu [Hal. 9].');
    let r = await api(app, T.presales).post(`/api/v1/documents/${id}/analyses`, { kind: 'SUMMARY' });
    expect(r.status).toBe(202);
    await runJobsOnce(sql, 3);
    let a = await api(app, T.presales).get(`/api/v1/documents/${id}/analyses/${r.body.id}`);
    expect(a.body.status).toBe('DONE');
    expect(a.body.verification.invalidPageRefs).toEqual([9]);
    // RISKS: 1 kutipan valid + 1 karangan
    aiQueue.push(JSON.stringify([
      { category: 'PAYMENT', statement: 'Jaminan penawaran 3%', severity: 'HIGH', quote: 'menyerahkan Jaminan Penawaran sebesar 3% dari nilai HPS', page: 1 },
      { category: 'PENALTY', statement: 'Denda 10% per hari', severity: 'CRITICAL', quote: 'denda sebesar 10% per hari keterlambatan', page: 2 },
    ]));
    r = await api(app, T.presales).post(`/api/v1/documents/${id}/analyses`, { kind: 'RISKS' });
    await runJobsOnce(sql, 3);
    a = await api(app, T.presales).get(`/api/v1/documents/${id}/analyses/${r.body.id}`);
    expect(a.body.result.items).toHaveLength(1);
    expect(a.body.verification.rejectedUnverified).toBe(1);
    // EXTRACT
    aiQueue.push(JSON.stringify({ sla_p1: { value: '30 menit', quote: 'SLA respons P1 maksimal 30 menit', page: 2 }, nilai_kontrak: { value: 'Rp 9 M', quote: 'nilai kontrak Rp 9 miliar', page: 1 } }));
    r = await api(app, T.presales).post(`/api/v1/documents/${id}/analyses`, { kind: 'EXTRACT', fields: [{ name: 'sla_p1' }, { name: 'nilai_kontrak' }] });
    await runJobsOnce(sql, 3);
    a = await api(app, T.presales).get(`/api/v1/documents/${id}/analyses/${r.body.id}`);
    expect(a.body.result.fields.sla_p1.value).toBe('30 menit');
    expect(a.body.result.fields.nilai_kontrak).toBeNull();
    expect(a.body.verification.notFound).toEqual(['nilai_kontrak']);
    // QA dengan sitasi terverifikasi
    aiQueue.push(JSON.stringify({ answer: 'Minimal OSCP atau CEH dengan pengalaman 3 tahun.', citations: [{ page: 2, quote: 'minimal memiliki sertifikasi OSCP atau CEH' }] }));
    r = await api(app, T.presales).post(`/api/v1/documents/${id}/analyses`, { kind: 'QA', question: 'Apa syarat sertifikasi tenaga ahli?' });
    await runJobsOnce(sql, 3);
    a = await api(app, T.presales).get(`/api/v1/documents/${id}/analyses/${r.body.id}`);
    expect(a.body.verification.grounded).toBe(true);
    expect(a.body.result.retrievedPages).toContain(2);
  });

  it('RESTRICTED documents are hidden from others and never sent to AI; disabled feature blocks analysis', async () => {
    const up = await upload(T.presales, '/api/v1/documents', { title: 'Konfigurasi firewall klien', confidentiality: 'RESTRICTED' }, Buffer.from('rahasia konfigurasi'), 'fw.txt', 'text/plain');
    await runJobsOnce(sql, 3);
    expect((await api(app, T.sales).get(`/api/v1/documents/${up.body.id}`)).status).toBe(404);
    expect((await api(app, T.aud).get(`/api/v1/documents/${up.body.id}`)).status).toBe(200);
    expect((await api(app, T.presales).post(`/api/v1/documents/${up.body.id}/analyses`, { kind: 'SUMMARY' })).status).toBe(403);
    await api(app, T.admin).put('/api/v1/ai/features', { features: { document_qa: false } });
    expect((await api(app, T.presales).post(`/api/v1/documents/${ctx.nativeDoc}/analyses`, { kind: 'QA', question: 'apa saja syaratnya?' })).status).toBe(409);
    await api(app, T.admin).put('/api/v1/ai/features', { features: { document_qa: true } });
  });
});

describe('FlexGuard calculator', () => {
  it('special deal 162 MD × Rp1,5 jt = Rp243 jt is flagged as below floor (not a global rate card)', async () => {
    const r = await api(app, T.presales).post('/api/v1/flexguard/calculate', { tokens: 162, pricePerToken: 1_500_000, contractMonths: 12,
      plannedUsage: [{ serviceLine: 'VAPT', lines: [{ role: 'pm', md: 3 }, { role: 'lead', md: 5 }, { role: 'senior', md: 7 }, { role: 'junior', md: 3 }], timesPerYear: 4 }] });
    expect(r.status).toBe(200);
    expect(r.body.subtotal).toBe(243_000_000);
    expect(r.body.tax).toBe(26_730_000);
    expect(r.body.package).toBe('Business');
    expect(r.body.specialDeal).toBe(true);
    expect(r.body.belowFloor).toBe(true);
    expect(r.body.floorPerToken).toBe(2_500_000);
    expect(r.body.bonusTokens).toBe(0);
    expect(r.body.complimentary[0]).toMatch(/Awareness/);
    expect(r.body.plannedUsage[0].tokensPerRun).toBe(23);
    expect(r.body.tokensPerYear).toBe(92);
    expect(r.body.policy.status).toBe('PENDING_OWNER_APPROVAL');
    const std = await api(app, T.presales).post('/api/v1/flexguard/calculate', { tokens: 100 });
    expect(std.body.pricePerToken).toBe(2_600_000);
    expect(std.body.bonusTokens).toBe(3);
    expect(std.body.membership).toBe('Gold');
  });
});

describe('Phase 3: contract lifecycle → FlexGuard wallet → service request', () => {
  const acceptedQuotation = async (name: string, unitPrice: number, qty: number) => {
    const s = api(app, T.sales);
    const o = await s.post('/api/v1/opportunities', { customerId: ctx.customer.id, name, serviceCategory: 'VAPT', amountEstimate: unitPrice * qty });
    const q = await s.post('/api/v1/quotations', { opportunityId: o.body.id, title: name, lines: [{ description: `${name} — FlexGuard token`, qty, unit: 'token', unitPrice }] });
    const sub = await s.post(`/api/v1/quotations/${q.body.id}/submit`);
    for (const st of sub.body.steps) {
      const who = st.level === 1 ? T.mgr : st.level === 2 ? T.vp : T.dir;
      expect((await api(app, who).post(`/api/v1/approvals/${sub.body.approvalRequestId}/decide`, { decision: 'APPROVE' })).status).toBe(200);
    }
    expect((await s.post(`/api/v1/quotations/${q.body.id}/issue`)).status).toBe(200);
    await s.post(`/api/v1/quotations/${q.body.id}/mark-sent`, { channel: 'portal' });
    expect((await api(app, T.cust).post(`/api/v1/portal/quotations/${q.body.id}/respond`, { response: 'ACCEPT', acknowledgement: true })).status).toBe(200);
    return { oppId: o.body.id, quotationId: q.body.id };
  };

  it('[#8] accepted quotation enters contracting; legal review (SoD) → DoA approval incl. below-floor → signatures', async () => {
    const { oppId, quotationId } = await acceptedQuotation('FlexGuard 162 token', 1_500_000, 162);
    ctx.oppId = oppId;
    const s = api(app, T.sales);
    const body = { contractType: 'FLEXGUARD', startDate: '2026-11-01', endDate: '2027-10-31', flexguard: { tokens: 162, pricePerToken: 1_500_000, validMonths: 12 } };
    const bad = await s.post(`/api/v1/contracts/from-quotation/${quotationId}`, { ...body, flexguard: { tokens: 100, pricePerToken: 1_500_000 } });
    expect(bad.status).toBe(422);
    const c = await s.post(`/api/v1/contracts/from-quotation/${quotationId}`, body, { 'idempotency-key': 'contract-1' });
    expect(c.status).toBe(201);
    expect(c.body.number).toMatch(/^001\/DEIT-PKS\//);
    expect((await s.post(`/api/v1/contracts/from-quotation/${quotationId}`, body)).status).toBe(409);
    ctx.contract = c.body;
    const det = await s.get(`/api/v1/contracts/${c.body.id}`);
    expect(det.body.obligations.find((o: any) => o.kind === 'PAYMENT').amount).toBe(243_000_000);
    expect((await s.post(`/api/v1/contracts/${c.body.id}/activate`)).status).toBe(422);
    expect((await s.post(`/api/v1/contracts/${c.body.id}/submit-legal`)).status).toBe(200);
    const checklist = Object.fromEntries(det.body.legalChecklistKeys.map((k: string) => [k, true]));
    expect((await s.post(`/api/v1/contracts/${c.body.id}/legal-review`, { checklist, decision: 'APPROVE' })).status).toBe(403);
    const partial = await api(app, T.legal).post(`/api/v1/contracts/${c.body.id}/legal-review`, { checklist: { identitas_para_pihak: true }, decision: 'APPROVE' });
    expect(partial.status).toBe(422);
    const lr = await api(app, T.legal).post(`/api/v1/contracts/${c.body.id}/legal-review`, { checklist, decision: 'APPROVE' });
    expect(lr.status).toBe(200);
    expect(lr.body.steps.map((x: any) => x.level)).toEqual([1, 2, 3]); // 243 jt → VP, tapi harga token < floor → Direktur
    for (const who of ['mgr', 'vp', 'dir']) expect((await api(app, T[who]).post(`/api/v1/approvals/${lr.body.approvalRequestId}/decide`, { decision: 'APPROVE' })).status).toBe(200);
    expect((await s.get(`/api/v1/contracts/${c.body.id}`)).body.contract.status).toBe('PENDING_SIGNATURE');
    // Otorisasi internal: VP (level 2) < level kontrak (3) → ditolak; Direktur OK
    expect((await api(app, T.vp).post(`/api/v1/contracts/${c.body.id}/signatures/internal`, { signerTitle: 'VP', confirm: true })).status).toBe(403);
    expect((await api(app, T.dir).post(`/api/v1/contracts/${c.body.id}/signatures/internal`, { signerTitle: 'Direktur Utama', confirm: true })).status).toBe(200);
    // Customer mengunggah kontrak bertanda tangan via portal → Legal verifikasi
    const signed = await upload(T.cust, `/api/v1/portal/contracts/${c.body.id}/signed-upload`, { signerName: 'Bpk. Direktur Bank' }, await makeRksPdf([['PERJANJIAN KERJA SAMA FLEXGUARD', 'Ditandatangani para pihak']]), 'pks-signed.pdf');
    expect(signed.status).toBe(201);
    expect((await s.post(`/api/v1/contracts/${c.body.id}/activate`)).status).toBe(422);
    const sig = (await s.get(`/api/v1/contracts/${c.body.id}`)).body.signatures.find((x: any) => x.party === 'CUSTOMER');
    expect((await api(app, T.legal).post(`/api/v1/contracts/${c.body.id}/signatures/${sig.id}/verify`, { decision: 'VERIFY', note: 'Tanda tangan & materai sesuai' })).status).toBe(200);
  });

  it('[#9] activation creates the project (handover) and the FlexGuard wallet; opportunity WON', async () => {
    const s = api(app, T.sales);
    const act = await s.post(`/api/v1/contracts/${ctx.contract.id}/activate`, {}, { 'idempotency-key': 'activate-1' });
    expect(act.status).toBe(200);
    expect(act.body.projectCode).toMatch(/^PRJ-/);
    expect(act.body.walletId).toBeTruthy();
    const again = await s.post(`/api/v1/contracts/${ctx.contract.id}/activate`, {}, { 'idempotency-key': 'activate-1' });
    expect(again.body.projectId).toBe(act.body.projectId);
    ctx.walletId = act.body.walletId;
    ctx.projectId = act.body.projectId;
    const opp = await s.get(`/api/v1/opportunities/${ctx.oppId}`);
    expect(opp.body.opportunity.stage).toBe('WON');
    const w = await api(app, T.presales).get(`/api/v1/flexguard/wallets/${ctx.walletId}`);
    expect(w.body.wallet.creditedTokens).toBe(162);
    expect(w.body.wallet.availableTokens).toBe(162);
    expect(w.body.wallet.package).toMatch(/special/);
    expect(w.body.wallet.complimentary[0].status).toBe('AVAILABLE');
    expect(w.body.reconciliation.ok).toBe(true);
    // Kickoff butuh PM & checklist lengkap
    const pmUser = (await api(app, T.pm).get('/api/v1/auth/me')).body;
    const pj = api(app, T.pm);
    expect((await pj.post(`/api/v1/projects/${ctx.projectId}/kickoff`)).status).toBe(422);
    await pj.patch(`/api/v1/projects/${ctx.projectId}`, { pmId: pmUser.id });
    const p = await pj.get(`/api/v1/projects/${ctx.projectId}`);
    expect(p.body.milestones.length).toBeGreaterThanOrEqual(1);
    for (const it of p.body.project.handover.items) await pj.patch(`/api/v1/projects/${ctx.projectId}`, { handoverItem: { key: it.key, done: true } });
    expect((await pj.post(`/api/v1/projects/${ctx.projectId}/kickoff`)).status).toBe(200);
  });

  it('[#10] service request: estimate (TDC) → below-floor approval → customer approval reserves → timesheets → BAST consumes; no negative balance', async () => {
    const c = api(app, T.cust);
    expect((await c.post('/api/v1/portal/flexguard/requests', { walletId: ctx.walletId, serviceLine: 'SOC_MDR', title: 'Monitoring SOC' })).status).toBe(400);
    const sr = await c.post('/api/v1/portal/flexguard/requests', { walletId: ctx.walletId, serviceLine: 'VAPT', title: 'VAPT Mobile Banking Q1' });
    expect(sr.status).toBe(201);
    const id = sr.body.id;
    const est = await api(app, T.presales).post(`/api/v1/flexguard/requests/${id}/estimate`, { lines: [{ role: 'pm', md: 3 }, { role: 'lead', md: 5 }, { role: 'senior', md: 7 }, { role: 'junior', md: 3 }] });
    expect(est.status).toBe(200);
    expect(est.body.tokens).toBe(23); // contoh A dokumen FlexGuard
    expect(est.body.floor.belowFloor).toBe(true);
    expect((await api(app, T.presales).post(`/api/v1/flexguard/requests/${id}/estimate`, { lines: [{ role: 'lead', md: 5, tdc: 1.0 }] })).status).toBe(422); // no under-debit
    await api(app, T.presales).post(`/api/v1/flexguard/requests/${id}/estimate`, { lines: [{ role: 'pm', md: 3 }, { role: 'lead', md: 5 }, { role: 'senior', md: 7 }, { role: 'junior', md: 3 }] });
    const send = await api(app, T.sales).post(`/api/v1/flexguard/requests/${id}/send-to-customer`);
    expect(send.body.approvalRequired).toBe(true);
    for (const who of ['mgr', 'vp', 'dir']) {
      const r = await api(app, T[who]).post(`/api/v1/approvals/${send.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
      expect(r.status, who).toBe(200);
    }
    const ap = await c.post(`/api/v1/portal/flexguard/requests/${id}/approve`, {}, { 'idempotency-key': 'sr-approve-1' });
    expect(ap.status).toBe(200);
    expect(ap.body.wallet).toEqual({ available: 139, reserved: 23 });
    const ap2 = await c.post(`/api/v1/portal/flexguard/requests/${id}/approve`, {}, { 'idempotency-key': 'sr-approve-1' });
    expect(ap2.headers['idempotent-replay']).toBe('true');
    const pmUser = (await api(app, T.pm).get('/api/v1/auth/me')).body;
    expect((await api(app, T.pm).post(`/api/v1/flexguard/requests/${id}/start`, { pmId: pmUser.id })).status).toBe(200);
    // Realisasi: PM 3, Lead 4, Senior 7, Junior 3 = 21 token (< 23 reserved)
    const plan: [string, number][] = [['pm', 3], ['lead', 4], ['senior', 7], ['junior', 3]];
    let day = 1;
    const ts: string[] = [];
    for (const [role, n] of plan) for (let i = 0; i < n; i++) {
      const r = await api(app, T.presales).post(`/api/v1/flexguard/requests/${id}/timesheets`, { workDate: `2026-09-${String(day++).padStart(2, '0')}`, role, md: 1 });
      expect(r.status).toBe(201);
      ts.push(r.body.id);
    }
    expect((await api(app, T.pm).post(`/api/v1/flexguard/requests/${id}/deliver`, { deliverableRef: 'LAP-VAPT-001' })).status).toBe(422); // timesheet belum diputuskan
    for (const t of ts) expect((await api(app, T.pm).post(`/api/v1/flexguard/requests/${id}/timesheets/${t}/decide`, { decision: 'APPROVE' })).status).toBe(200);
    const dl = await api(app, T.pm).post(`/api/v1/flexguard/requests/${id}/deliver`, { deliverableRef: 'LAP-VAPT-001' });
    expect(dl.body.actualTokens).toBe(21);
    const acc = await c.post(`/api/v1/portal/flexguard/requests/${id}/accept`, {}, { 'idempotency-key': 'sr-accept-1' });
    expect(acc.status).toBe(200);
    expect(acc.body.wallet).toEqual({ available: 141, reserved: 0, consumed: 21 });
    ctx.sr1 = id;
    // Over-consumption: estimasi melebihi saldo → reservasi ditolak
    const big = await c.post('/api/v1/portal/flexguard/requests', { walletId: ctx.walletId, serviceLine: 'RED_TEAM', title: 'Full APT simulation' });
    await api(app, T.presales).post(`/api/v1/flexguard/requests/${big.body.id}/estimate`, { lines: [{ role: 'lead', md: 80 }] });
    await sql`UPDATE service_requests SET status = 'PENDING_CUSTOMER_APPROVAL' WHERE id = ${big.body.id}`;
    const over = await c.post(`/api/v1/portal/flexguard/requests/${big.body.id}/approve`);
    expect(over.status).toBe(422);
    expect(over.body.message).toMatch(/Saldo tersedia tidak cukup/);
    await expect(sql`UPDATE wallet_transactions SET reason = 'tamper'`).rejects.toThrow(/append-only/);
    await expect(sql`UPDATE flexguard_wallets SET available_tokens = -1 WHERE id = ${ctx.walletId}`).rejects.toThrow(/check/);
  });

  it('cancellation releases reservation (scoping fee ≤ 1 token); reversal & top-up require approval; statement & reconciliation', async () => {
    const c = api(app, T.cust);
    const sr = await c.post('/api/v1/portal/flexguard/requests', { walletId: ctx.walletId, serviceLine: 'IT_AUDIT', title: 'Audit ASPI' });
    await api(app, T.presales).post(`/api/v1/flexguard/requests/${sr.body.id}/estimate`, { lines: [{ role: 'lead', md: 1 }] });
    await sql`UPDATE service_requests SET status = 'PENDING_CUSTOMER_APPROVAL' WHERE id = ${sr.body.id}`;
    await c.post(`/api/v1/portal/flexguard/requests/${sr.body.id}/approve`);
    expect((await api(app, T.sales).post(`/api/v1/flexguard/requests/${sr.body.id}/cancel`, { reason: 'Customer menunda', scopingFeeTokens: 2 })).status).toBe(400);
    const cancel = await api(app, T.sales).post(`/api/v1/flexguard/requests/${sr.body.id}/cancel`, { reason: 'Customer menunda', scopingFeeTokens: 1 });
    expect(cancel.status).toBe(200);
    let w = (await api(app, T.presales).get(`/api/v1/flexguard/wallets/${ctx.walletId}`)).body;
    expect([w.wallet.availableTokens, w.wallet.reservedTokens, w.wallet.consumedTokens]).toEqual([140, 0, 22]);
    // Reversal debit SR1 (sengketa diselesaikan di luar sistem) → approval → token kembali
    const consumeTx = w.ledger.find((t: any) => t.type === 'CONSUME' && t.srCode && Number(t.dConsumed) === 21);
    const rv = await api(app, T.sales).post(`/api/v1/flexguard/wallets/${ctx.walletId}/requests`, { type: 'REVERSAL', txId: consumeTx.id, reason: 'Koreksi debit ganda temuan audit' });
    expect(rv.status).toBe(201);
    for (const st of rv.body.steps) await api(app, st.level === 1 ? T.mgr : st.level === 2 ? T.vp : T.dir).post(`/api/v1/approvals/${rv.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
    w = (await api(app, T.presales).get(`/api/v1/flexguard/wallets/${ctx.walletId}`)).body;
    expect([w.wallet.availableTokens, w.wallet.consumedTokens]).toEqual([161, 1]);
    // Top-up di bawah floor → Direktur
    const tu = await api(app, T.sales).post(`/api/v1/flexguard/wallets/${ctx.walletId}/requests`, { type: 'TOPUP', tokens: 50, reason: 'Top-up Q2 harga khusus' });
    expect(tu.body.requiredLevel).toBe(3);
    for (const st of tu.body.steps) await api(app, st.level === 1 ? T.mgr : st.level === 2 ? T.vp : T.dir).post(`/api/v1/approvals/${tu.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
    w = (await api(app, T.presales).get(`/api/v1/flexguard/wallets/${ctx.walletId}`)).body;
    expect([w.wallet.availableTokens, w.wallet.creditedTokens]).toEqual([211, 212]);
    expect(w.reconciliation.ok).toBe(true);
    const month = new Date().toISOString().slice(0, 7);
    const st = await api(app, T.cust).get(`/api/v1/portal/flexguard/wallets/${ctx.walletId}/ledger`);
    expect(st.body.ledger.length).toBeGreaterThanOrEqual(7);
    const stmt = await api(app, T.presales).get(`/api/v1/flexguard/wallets/${ctx.walletId}/statement?month=${month}`);
    expect(stmt.body.movements.consumed).toBe(1);
    expect(stmt.body.closing.available).toBe(211);
    expect((await api(app, T.cust).get('/api/v1/flexguard/wallets')).status).toBe(403);
  });

  it('expiry moves available tokens to expired; e-sign sandbox webhook is HMAC-verified', async () => {
    await sql`UPDATE flexguard_wallets SET valid_from = current_date - 400, valid_until = current_date - 1 WHERE id = ${ctx.walletId}`;
    const r = await expireWallets(sql, null, null);
    expect(r.expired).toBe(1);
    const w = (await api(app, T.presales).get(`/api/v1/flexguard/wallets/${ctx.walletId}`)).body;
    expect(w.wallet.status).toBe('EXPIRED');
    expect([w.wallet.availableTokens, w.wallet.expiredTokens]).toEqual([0, 211]);
    expect(w.reconciliation.ok).toBe(true);
    // Kontrak proyek kedua dengan e-sign sandbox
    const { quotationId } = await acceptedQuotation('VAPT Proyek', 40_000_000, 1);
    const c = await api(app, T.sales).post(`/api/v1/contracts/from-quotation/${quotationId}`, { contractType: 'PROJECT', startDate: '2026-11-01', endDate: '2027-01-31' });
    const det = (await api(app, T.sales).get(`/api/v1/contracts/${c.body.id}`)).body;
    expect(det.obligations.filter((o: any) => o.kind === 'PAYMENT').map((o: any) => o.amount)).toEqual([12_000_000, 20_000_000, 8_000_000]);
    await api(app, T.sales).post(`/api/v1/contracts/${c.body.id}/submit-legal`);
    const lr = await api(app, T.legal).post(`/api/v1/contracts/${c.body.id}/legal-review`, { checklist: Object.fromEntries(det.legalChecklistKeys.map((k: string) => [k, true])), decision: 'APPROVE' });
    expect(lr.body.steps.map((x: any) => x.level)).toEqual([1]);
    await api(app, T.mgr).post(`/api/v1/approvals/${lr.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
    expect((await api(app, T.sales).post(`/api/v1/contracts/${c.body.id}/signatures/customer/esign`, { provider: 'privy', signerName: 'Ibu X', signerEmail: 'x@bank.co.id' })).status).toBe(422);
    const env = await api(app, T.sales).post(`/api/v1/contracts/${c.body.id}/signatures/customer/esign`, { provider: 'sandbox', signerName: 'Ibu Direktur', signerEmail: 'dir@bank.co.id' });
    expect(env.status).toBe(200);
    expect(env.body.legallyBinding).toBe(false);
    const payload = JSON.stringify({ providerRef: env.body.providerRef, event: 'SIGNED' });
    const bad = await app.inject({ method: 'POST', url: '/api/v1/esign/webhook/sandbox', payload, headers: { 'content-type': 'application/json', 'x-signature': 'sha256=deadbeef' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/v1/esign/webhook/sandbox', payload, headers: { 'content-type': 'application/json', 'x-signature': signSandboxPayload(payload) } });
    expect(good.json().status).toBe('SIGNED'); // sandbox tidak tersertifikasi → tetap perlu verifikasi Legal
    const sig = (await api(app, T.sales).get(`/api/v1/contracts/${c.body.id}`)).body.signatures[0];
    await api(app, T.legal).post(`/api/v1/contracts/${c.body.id}/signatures/${sig.id}/verify`, { decision: 'VERIFY', note: 'UAT sandbox — diverifikasi manual' });
    await api(app, T.mgr).post(`/api/v1/contracts/${c.body.id}/signatures/internal`, { signerTitle: 'Sales Manager', confirm: true });
    const act = await api(app, T.sales).post(`/api/v1/contracts/${c.body.id}/activate`);
    expect(act.status).toBe(200);
    expect(act.body.walletId).toBeNull();
    const audit = await api(app, T.aud).get(`/api/v1/audit?entityType=contract&entityId=${c.body.id}`);
    expect(audit.body.items.map((x: any) => x.action)).toEqual(expect.arrayContaining(['contract.create', 'contract.legal_approved', 'contract.esign_requested', 'contract.esign_webhook', 'contract.activate']));
  });
});

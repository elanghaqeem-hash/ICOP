/**
 * Phase 2 acceptance — Tender Center, RKS extraction, compliance matrix, Bid/No-Bid, Proposal Generator,
 * vendor price list/BOM, CTI & GRC scoping, simulation, delegation & SLA escalation. PostgreSQL nyata.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { resetBreakers } from '../src/modules/ai/gateway.js';
import { runJobsOnce } from '../src/lib/jobs.js';
import { SEED_PW, api, freshDb, login, makeApp } from './helpers.js';
import { makeRksPdf, makeScannedPdf, multipart } from './fixtures/rks.js';

let sql: Sql;
let app: FastifyInstance;
const aiQueue: string[] = [];
const fakeFetch = async (_url: string, _init: RequestInit) => {
  const text = aiQueue.shift();
  if (text === undefined) return new Response('{"error":"no mock"}', { status: 500 });
  return Response.json({ content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } });
};
const T: Record<string, string> = {};
const ctx: Record<string, any> = {};
const upload = async (token: string, tenderId: string, kind: string, filename: string, content: Buffer, type = 'application/pdf') => {
  const mp = multipart({ kind }, { name: 'file', filename, content, type });
  const r = await app.inject({ method: 'POST', url: `/api/v1/tenders/${tenderId}/documents`, payload: mp.payload, headers: { ...mp.headers, authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() };
};

beforeAll(async () => {
  sql = await freshDb();
  app = await makeApp(sql, fakeFetch as never);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];
  process.env.UPLOAD_DIR = '/tmp/icop-test-uploads';
  const users = { tender: 'tender@defendit360.com', sales: 'sales@defendit360.com', presales: 'presales@defendit360.com', arch: 'architect@defendit360.com',
    mgr: 'salesmanager@defendit360.com', vp: 'vp@defendit360.com', dir: 'direktur@defendit360.com', legal: 'legal@defendit360.com',
    fin: 'finance@defendit360.com', admin: 'companyadmin@defendit360.com', aud: 'auditor@defendit360.com' };
  for (const [k, e] of Object.entries(users)) T[k] = await login(app, e);
  const c = await api(app, T.sales).post('/api/v1/customers', { legalName: 'Badan Siber Demo Provinsi', industry: 'government', classification: 'B2G', clientTier: 'D' });
  ctx.customer = c.body;
});
afterAll(async () => { await app.close(); await sql.end(); });

describe('Owner-approved policies', () => {
  it('PRICING-BRD2 v2 ACTIVE; DOA-MP-2026 v3 (v2 + kontrak/FlexGuard) ACTIVE; v1/v2 retired; BRD DoA kept as alternative', async () => {
    const r = await api(app, T.fin).get('/api/v1/policies');
    const by = (c: string, v: number) => r.body.items.find((p: any) => p.code === c && p.version === v);
    expect(by('PRICING-BRD2', 2).status).toBe('ACTIVE');
    expect(by('PRICING-BRD2', 2).isCurrent).toBe(true);
    expect(by('DOA-MP-2026', 2).status).toBe('RETIRED');
    expect(by('DOA-MP-2026', 3).status).toBe('ACTIVE');
    expect(by('DOA-MP-2026', 3).isCurrent).toBe(true);
    expect(by('DOA-MP-2026', 3).params.rules.map((x: any) => x.type)).toEqual(expect.arrayContaining(['TENDER', 'CONTRACT_VALUE', 'FLEXGUARD_VALUE']));
    expect(by('FLEXGUARD-PD1', 1).status).toBe('PENDING_OWNER_APPROVAL');
    expect(by('DOA-MP-2026', 3).sourceNote).toMatch(/Disahkan owner/);
    expect(by('DOA-BRD-2.0', 1).status).toBe('DRAFT');
  });
});

describe('Tender Center', () => {
  it('imports from legitimate sources with relevance filter & duplicate detection', async () => {
    const t = api(app, T.tender);
    const base = { procuringEntity: 'Badan Siber Demo Provinsi', source: 'sirup', submissionDeadline: new Date(Date.now() + 10 * 864e5).toISOString() };
    const r = await t.post('/api/v1/tenders/import', { items: [
      { ...base, title: 'Pengadaan Jasa Managed SOC dan Penetration Test 2026', sourceRef: 'SIRUP-001', hpsValue: 2_500_000_000, serviceCategory: 'SOC_MDR' },
      { ...base, title: 'Pengadaan Jasa Managed SOC dan Penetration Test 2026', sourceRef: 'SIRUP-001' },
      { ...base, title: 'Pengadaan Alat Tulis Kantor Tahun 2026', sourceRef: 'SIRUP-002' },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.created).toHaveLength(1);
    expect(r.body.duplicates).toHaveLength(1);
    expect(r.body.skippedIrrelevant).toHaveLength(1);
    const list = await t.get('/api/v1/tenders?active=true');
    ctx.tender = list.body.items[0];
    expect(ctx.tender.relevanceScore).toBeGreaterThanOrEqual(60);
    expect(ctx.tender.classification).toBe('CYBERSECURITY');
    const manual = await t.post('/api/v1/tenders', { title: 'Pengadaan Jasa Managed SOC & Penetration Test 2026', procuringEntity: 'Badan Siber Demo Provinsi' });
    expect(manual.status).toBe(409);
    const notes = await t.get('/api/v1/notifications');
    expect(notes.body.items.some((n: any) => n.kind === 'TENDER_RELEVANT')).toBe(true);
    expect((await api(app, T.legal).post('/api/v1/tenders', { title: 'x tender test', procuringEntity: 'abc' })).status).toBe(403);
  });

  it('registration requires a customer and auto-creates the tender opportunity', async () => {
    const t = api(app, T.tender);
    const id = ctx.tender.id;
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'SCREENING' })).status).toBe(200);
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'REGISTERED' })).status).toBe(422);
    const cur = await t.get(`/api/v1/tenders/${id}`);
    expect((await t.patch(`/api/v1/tenders/${id}`, { customerId: ctx.customer.id, rowVersion: cur.body.tender.rowVersion })).status).toBe(200);
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'REGISTERED' })).status).toBe(200);
    const after = await t.get(`/api/v1/tenders/${id}`);
    expect(after.body.tender.opportunityId).toBeTruthy();
    ctx.oppId = after.body.tender.opportunityId;
    const opp = await api(app, T.sales).get(`/api/v1/opportunities/${ctx.oppId}`);
    expect(opp.body.opportunity.isTender).toBe(true);
    expect(opp.body.opportunity.amountEstimate).toBe(2_500_000_000);
  });

  it('[#11] RKS upload → text extraction → requirements; AI items without verifiable source are rejected', async () => {
    const id = ctx.tender.id;
    const pdf = await makeRksPdf();
    const up = await upload(T.tender, id, 'RKS', 'RKS SOC 2026.pdf', pdf);
    expect(up.status).toBe(201);
    expect(up.body.extractionStatus).toBe('DONE');
    expect(up.body.pageCount).toBe(2);
    expect((await upload(T.tender, id, 'RKS', 'copy.pdf', pdf)).status).toBe(409);
    expect((await upload(T.tender, id, 'RKS', 'evil.exe', Buffer.from('MZ\x90\x00binary'), 'application/octet-stream')).status).toBe(400);
    const scan = await upload(T.tender, id, 'KAK', 'scan.pdf', await makeScannedPdf());
    expect(scan.body.extractionStatus).toBe('OCR_QUEUED');
    await runJobsOnce(sql);
    const [scanRow] = await sql`SELECT extraction_status FROM tender_documents WHERE id = ${scan.body.id}`;
    expect(scanRow.extractionStatus).toBe('FAILED'); // halaman kosong — OCR tidak menemukan teks
    expect((await api(app, T.tender).post(`/api/v1/tenders/${id}/documents/${scan.body.id}/extract`, {})).status).toBe(422);

    resetBreakers();
    aiQueue.push(JSON.stringify([
      { category: 'COMMERCIAL', requirement: 'Harga tidak melebihi HPS termasuk PPN', mandatory: true, source_excerpt: 'Harga penawaran tidak boleh melebihi HPS dan sudah termasuk PPN', page: 2 },
      { category: 'QUALIFICATION', requirement: 'Wajib CMMI level 5', mandatory: true, source_excerpt: 'Peserta wajib memiliki sertifikat CMMI level 5', page: 2 },
    ]));
    const ex = await api(app, T.tender).post(`/api/v1/tenders/${id}/documents/${up.body.id}/extract`, { useAi: true });
    expect(ex.status).toBe(200);
    expect(ex.body.rule).toBe(10);
    expect(ex.body.ai.rejectedUnverified).toBe(1);
    expect(ex.body.added).toBe(10);
    const det = await api(app, T.tender).get(`/api/v1/tenders/${id}`);
    const reqs = det.body.requirements;
    const count = (c: string) => reqs.filter((r: any) => r.category === c).length;
    expect([count('ADMINISTRATIVE'), count('QUALIFICATION'), count('TECHNICAL'), count('COMMERCIAL')]).toEqual([3, 3, 3, 1]);
    expect(reqs.find((r: any) => /dashboard/.test(r.requirement)).mandatory).toBe(false);
    expect(reqs.every((r: any) => r.sourceExcerpt && r.sourcePage)).toBe(true);
    expect(reqs.some((r: any) => /CMMI/.test(r.requirement))).toBe(false);
    ctx.reqs = reqs;
    const csv = await app.inject({ method: 'GET', url: `/api/v1/tenders/${id}/compliance-matrix.csv`, headers: { authorization: `Bearer ${T.tender}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split('\r\n')).toHaveLength(11);
  });

  it('Bid/No-Bid scorecard → DoA tender approval (HPS > Rp1 M ⇒ Director) → PREPARING', async () => {
    const id = ctx.tender.id;
    const t = api(app, T.tender);
    expect((await t.post(`/api/v1/tenders/${id}/bid-assessment`, { scores: { strategic_fit: { score: 4 } }, conflictOfInterest: false })).status).toBe(400);
    const crit = (await t.get(`/api/v1/tenders/${id}`)).body.criteria;
    const scores = Object.fromEntries(crit.map((c: any) => [c.key, { score: 4 }]));
    const b = await t.post(`/api/v1/tenders/${id}/bid-assessment`, { scores, conflictOfInterest: false });
    expect(b.status).toBe(201);
    expect(b.body.bidAssessment.recommendation).toBe('GO');
    expect(b.body.bidAssessment.weightedScore).toBe(75);
    expect(b.body.steps.map((s: any) => s.level)).toEqual([1, 2, 3]);
    for (const who of ['mgr', 'vp', 'dir']) {
      const d = await api(app, T[who]).post(`/api/v1/approvals/${b.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
      expect(d.status).toBe(200);
    }
    const det = await t.get(`/api/v1/tenders/${id}`);
    expect(det.body.tender.status).toBe('PREPARING');
    expect(det.body.bids[0].finalDecision).toBe('GO');
    const ap = await api(app, T.aud).get(`/api/v1/approvals/${b.body.approvalRequestId}`);
    expect(ap.body.entity.tenderCode).toBe(det.body.tender.code);
  });

  it('compliance review gate: evidence required; internal review blocked until mandatory reviewed', async () => {
    const id = ctx.tender.id;
    const t = api(app, T.tender);
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'INTERNAL_REVIEW' })).status).toBe(422);
    const adm = ctx.reqs.find((r: any) => r.category === 'ADMINISTRATIVE');
    expect((await t.patch(`/api/v1/tenders/${id}/requirements/${adm.id}`, { complianceStatus: 'COMPLY' })).status).toBe(400);
    for (const r of ctx.reqs) {
      const body = r.category === 'COMMERCIAL' || r.category === 'TECHNICAL' ? { complianceStatus: 'COMPLY', response: 'Dipenuhi' }
        : /CEH/.test(r.requirement) ? { complianceStatus: 'CLARIFY', response: 'Konfirmasi apakah sertifikasi setara diterima' }
          : { complianceStatus: 'COMPLY', evidence: `DOK-${r.refCode}` };
      expect((await t.patch(`/api/v1/tenders/${id}/requirements/${r.id}`, body)).status).toBe(200);
    }
    aiQueue.push(`${ctx.reqs.find((r: any) => /CEH/.test(r.requirement)).refCode}: Mohon konfirmasi apakah sertifikasi CREST/GPEN dapat diterima sebagai setara OSCP/CEH?\nXYZ-999: pertanyaan untuk ref palsu`);
    const q = await t.post(`/api/v1/tenders/${id}/clarifications/ai-draft`, {});
    expect(q.status).toBe(201);
    expect(q.body.created).toHaveLength(1);
    expect(q.body.created[0].status).toBe('DRAFT');
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'INTERNAL_REVIEW' })).status).toBe(200);
  });
});

describe('Proposal Generator', () => {
  it('[#12] generates 20 grounded sections; never invents certifications, references or personnel', async () => {
    // Scoping SOC untuk opportunity tender
    const p = api(app, T.presales);
    const a = await p.post('/api/v1/assessments', { customerId: ctx.customer.id, opportunityId: ctx.oppId, serviceType: 'SOC',
      answers: { assets: { windows_server: 20, firewall: 4, edr_unified: 1 }, logSources: 25, coverage: '24x7', serviceTier: 'standard', contractMonths: 12, siemPlatform: 'FortiSIEM', retentionDays: 365 } });
    await p.post(`/api/v1/assessments/${a.body.id}/calculate`, {});
    await p.post(`/api/v1/assessments/${a.body.id}/review`, {});
    const r = await p.post('/api/v1/proposals', { opportunityId: ctx.oppId, tenderId: ctx.tender.id }, { 'idempotency-key': 'prop-1' });
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^001\/DEIT-PRP\//);
    expect(r.body.sections).toHaveLength(20);
    const sec = (k: string) => r.body.sections.find((s: any) => s.key === k);
    expect(sec('compliance_matrix').content).toMatch(/RKS-001/);
    expect(sec('scope_of_work').content).toMatch(/FortiSIEM|windows server/i);
    expect(sec('company_capabilities').content).not.toMatch(/BSSN/); // fakta BSSN belum terverifikasi
    expect(sec('relevant_experience').content).toMatch(/PERLU DILENGKAPI/);
    expect(sec('organization').missingInfo.join(' ')).toMatch(/CV tenaga ahli/);
    expect(sec('executive_summary').sources.length).toBeGreaterThan(0);
    ctx.prop = r.body;
  });

  it('claim guard flags fabricated claims from humans and AI; reviewer cannot approve', async () => {
    const p = api(app, T.presales);
    const id = ctx.prop.id;
    const e = await p.put(`/api/v1/proposals/${id}/sections/company_capabilities`, { content: 'DefendIT360 bersertifikat ISO 27001 dan anggota CREST sejak 2015.' });
    expect(e.body.status).toBe('FLAGGED');
    expect(e.body.flags.join(' ')).toMatch(/CREST/i);
    resetBreakers();
    aiQueue.push('Kami adalah gold partner Fortinet dengan 150+ klien perbankan. Layanan SOC 24x7.');
    const ai = await p.post(`/api/v1/proposals/${id}/sections/service_specifications/ai`, { instruction: 'lebih ringkas' });
    expect(ai.status).toBe(200);
    expect(ai.body.status).toBe('FLAGGED');
    expect(ai.body.flags.join(' ')).toMatch(/gold partner|150/);
    expect((await p.post(`/api/v1/proposals/${id}/submit-review`, {})).status).toBe(422);
  });

  it('reviewer sign-off (SoD), DOCX export, versions & diff, re-review after edit', async () => {
    const p = api(app, T.presales);
    const id = ctx.prop.id;
    // Legal memverifikasi fakta BSSN (maker-checker: pembuat = admin seed)
    const facts = await api(app, T.legal).get('/api/v1/company-facts');
    const bssn = facts.body.items.find((f: any) => /BSSN/.test(f.title));
    expect((await api(app, T.legal).post(`/api/v1/company-facts/${bssn.id}/verify`, { evidenceRef: 'Surat BSSN No. DEMO/2026' })).status).toBe(200);
    // Lengkapi semua bagian yang masih ber-penanda / flagged
    const cur = (await p.get(`/api/v1/proposals/${id}`)).body;
    for (const s of cur.sections) {
      if (s.status === 'FLAGGED' || s.content.includes('[PERLU DILENGKAPI]')) {
        const clean = s.key === 'company_capabilities' ? 'Terdaftar di BSSN sebagai Lembaga Konsultan Sistem Manajemen Pengamanan Informasi.'
          : s.required ? `Isi ${s.title} telah dilengkapi berdasarkan hasil discovery bersama customer.` : '';
        const r = await p.put(`/api/v1/proposals/${id}/sections/${s.key}`, { content: clean });
        expect(r.body.status, s.key).not.toBe('FLAGGED');
      }
    }
    expect((await p.post(`/api/v1/proposals/${id}/submit-review`, {})).status).toBe(200);
    expect((await p.post(`/api/v1/proposals/${id}/review`, { decision: 'APPROVE' })).status).toBe(403); // pembuat
    expect((await api(app, T.sales).post(`/api/v1/proposals/${id}/review`, { decision: 'APPROVE' })).status).toBe(403);
    const rv = await api(app, T.arch).post(`/api/v1/proposals/${id}/review`, { decision: 'APPROVE', note: 'OK' });
    expect(rv.status).toBe(200);
    expect(rv.body.status).toBe('REVIEWED');
    const docx = await app.inject({ method: 'GET', url: `/api/v1/proposals/${id}/export.docx`, headers: { authorization: `Bearer ${T.presales}` } });
    expect(docx.statusCode).toBe(200);
    expect(docx.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(docx.headers['content-disposition']).not.toMatch(/DRAFT/);
    const html = await app.inject({ method: 'GET', url: `/api/v1/proposals/${id}/document`, headers: { authorization: `Bearer ${T.presales}` } });
    expect(html.body).toMatch(/Direview oleh/);
    expect(html.body).not.toMatch(/class="wm"/);
    // edit setelah review → DRAFT, versi naik, diff tersedia
    const ed = await p.put(`/api/v1/proposals/${id}/sections/timeline`, { content: 'Onboarding 6 minggu, lalu operasi 12 bulan.' });
    expect(ed.status).toBe(200);
    const after = (await p.get(`/api/v1/proposals/${id}`)).body;
    expect(after.status).toBe('DRAFT');
    expect(after.version).toBe(2);
    const versions = (await p.get(`/api/v1/proposals/${id}/versions`)).body.items;
    const reviewed = versions.find((v: any) => /reviewed/.test(v.reason));
    const diff = await p.get(`/api/v1/proposals/${id}/diff?from=${reviewed.id}&to=current`);
    expect(diff.body.sections.map((s: any) => s.key)).toEqual(['timeline']);
    expect((await p.post(`/api/v1/proposals/${id}/submit-review`, {})).status).toBe(200);
    expect((await api(app, T.arch).post(`/api/v1/proposals/${id}/review`, { decision: 'APPROVE' })).status).toBe(200);
  });
});

describe('Tender submission & award', () => {
  it('approval of tender documents needs Director (> Rp1 M) and full readiness; submission needs proof', async () => {
    const id = ctx.tender.id;
    const t = api(app, T.tender);
    const ceh = ctx.reqs.find((r: any) => /CEH/.test(r.requirement));
    let ready = (await t.get(`/api/v1/tenders/${id}`)).body.readiness;
    expect(ready.blockers.join(' ')).toMatch(/klarifikasi/);
    await t.patch(`/api/v1/tenders/${id}/requirements/${ceh.id}`, { complianceStatus: 'COMPLY', evidence: 'Jawaban aanwijzing: setara diterima' });
    ready = (await t.get(`/api/v1/tenders/${id}`)).body.readiness;
    expect(ready.ready).toBe(true);
    expect(ready.percent).toBe(100);
    expect((await api(app, T.vp).post(`/api/v1/tenders/${id}/status`, { to: 'APPROVED' })).status).toBe(403);
    expect((await api(app, T.dir).post(`/api/v1/tenders/${id}/status`, { to: 'APPROVED' })).status).toBe(200);
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'SUBMITTED' })).status).toBe(422);
    expect((await upload(T.tender, id, 'SUBMISSION_PROOF', 'bukti-upload-spse.txt', Buffer.from('Bukti submission SPSE no 123'), 'text/plain')).status).toBe(201);
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'SUBMITTED' })).status).toBe(200);
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'AWARDED' })).status).toBe(200);
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'CONTRACTING' })).status).toBe(422);
    expect((await upload(T.tender, id, 'AWARD_LETTER', 'SPPBJ.txt', Buffer.from('Surat penunjukan penyedia'), 'text/plain')).status).toBe(201);
    expect((await t.post(`/api/v1/tenders/${id}/status`, { to: 'CONTRACTING' })).status).toBe(200);
    const hist = (await t.get(`/api/v1/tenders/${id}`)).body.history.map((h: any) => h.toStatus);
    expect(hist).toEqual(['DISCOVERED', 'SCREENING', 'REGISTERED', 'BID_DECISION', 'PREPARING', 'INTERNAL_REVIEW', 'APPROVED', 'SUBMITTED', 'AWARDED', 'CONTRACTING']);
  });

  it('customer users cannot access the tender center', async () => {
    const [tn] = await sql`SELECT id FROM tenants WHERE code = 'DEIT'`;
    await sql`INSERT INTO users (tenant_id, email, full_name, password_hash, role, customer_id, force_password_change)
              VALUES (${tn.id}, 'pic@bsd.go.id', 'PIC', ${await bcrypt.hash(SEED_PW, 4)}, 'customer_user', ${ctx.customer.id}, false)`;
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'pic@bsd.go.id', password: SEED_PW } });
    const c = api(app, r.json().token);
    expect((await c.get('/api/v1/tenders')).status).toBe(403);
    expect((await c.get(`/api/v1/proposals/${ctx.prop.id}`)).status).toBe(403);
  });
});

describe('Delegation, SLA escalation & deadline reminders', () => {
  it('time-bound delegation lets a delegate decide a VP step; limits enforced; revocable', async () => {
    const t = api(app, T.tender);
    const n = await t.post('/api/v1/tenders', { title: 'Jasa Penetration Test Aplikasi 2026', procuringEntity: 'Badan Siber Demo Provinsi', customerId: ctx.customer.id,
      hpsValue: 400_000_000, submissionDeadline: new Date(Date.now() + 48 * 36e5).toISOString() });
    ctx.t2 = n.body;
    for (const s of ['SCREENING', 'REGISTERED']) await t.post(`/api/v1/tenders/${n.body.id}/status`, { to: s });
    const crit = (await t.get(`/api/v1/tenders/${n.body.id}`)).body.criteria;
    const b = await t.post(`/api/v1/tenders/${n.body.id}/bid-assessment`, { scores: Object.fromEntries(crit.map((c: any) => [c.key, { score: 3 }])), conflictOfInterest: false, conditions: 'Perlu subkon OSCP' });
    expect(b.body.bidAssessment.recommendation).toBe('CONDITIONAL_GO');
    expect(b.body.steps.map((s: any) => s.level)).toEqual([1, 2]);
    const vp = api(app, T.vp);
    const me = (await vp.get('/api/v1/auth/me')).body;
    const presalesId = (await api(app, T.presales).get('/api/v1/auth/me')).body.id;
    expect((await vp.post('/api/v1/approvals/delegations', { delegateId: presalesId, level: 3, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 5 * 864e5).toISOString(), reason: 'Cuti tahunan' })).status).toBe(403);
    expect((await vp.post('/api/v1/approvals/delegations', { delegateId: presalesId, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 40 * 864e5).toISOString(), reason: 'Cuti panjang' })).status).toBe(422);
    const d = await vp.post('/api/v1/approvals/delegations', { delegateId: presalesId, validFrom: new Date(Date.now() - 6e4).toISOString(), validUntil: new Date(Date.now() + 5 * 864e5).toISOString(), reason: 'Cuti tahunan' });
    expect(d.status).toBe(201);
    expect(me.role).toBe('vp_head');
    expect((await api(app, T.presales).get('/api/v1/approvals/my-authority')).body.level).toBe(2);
    await api(app, T.mgr).post(`/api/v1/approvals/${b.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
    const dd = await api(app, T.presales).post(`/api/v1/approvals/${b.body.approvalRequestId}/decide`, { decision: 'APPROVE', comment: 'a.n. VP' });
    expect(dd.status).toBe(200);
    expect(dd.body.finalStatus).toBe('APPROVED');
    const [ev] = await sql`SELECT evidence FROM approval_decisions WHERE request_id = ${b.body.approvalRequestId} ORDER BY id DESC LIMIT 1`;
    expect((ev.evidence as any).delegationId).toBe(d.body.id);
    expect((await vp.post(`/api/v1/approvals/delegations/${d.body.id}/revoke`, {})).status).toBe(200);
    expect((await api(app, T.presales).get('/api/v1/approvals/my-authority')).body.level).toBe(0);
  });

  it('SLA escalation notifies the next level; deadline reminder sent once per day', async () => {
    const s = api(app, T.sales);
    const o = await s.post('/api/v1/opportunities', { customerId: ctx.customer.id, name: 'Awareness training', serviceCategory: 'AWARENESS' });
    const q = await s.post('/api/v1/quotations', { opportunityId: o.body.id, title: 'Awareness', lines: [{ description: 'Kelas awareness', qty: 1, unit: 'kelas', unitPrice: 30_000_000 }] });
    const sub = await s.post(`/api/v1/quotations/${q.body.id}/submit`);
    await sql`UPDATE approval_requests SET due_at = now() - interval '1 hour' WHERE id = ${sub.body.approvalRequestId}`;
    expect((await s.post('/api/v1/admin/jobs/run', {})).status).toBe(403);
    const run = await api(app, T.admin).post('/api/v1/admin/jobs/run', {});
    expect(run.body.escalation.escalated).toBe(1);
    expect(run.body.tenderDeadlines.reminded).toBeGreaterThanOrEqual(1);
    const vpNotes = (await api(app, T.vp).get('/api/v1/notifications')).body.items;
    expect(vpNotes.some((n: any) => n.kind === 'APPROVAL_ESCALATED')).toBe(true);
    const again = await api(app, T.admin).post('/api/v1/admin/jobs/run', {});
    expect(again.body.escalation.escalated).toBe(0);
    expect(again.body.tenderDeadlines.reminded).toBe(0);
  });
});

describe('Vendor price list, BOM, CTI/GRC scoping, simulation', () => {
  it('vendor price list with FX, BOM builder with validity & authorization warnings', async () => {
    const pr = api(app, T.presales);
    const v = await pr.post('/api/v1/vendors', { name: 'Distributor SIEM Demo', vendorType: 'distributor', authorizationStatus: 'AUTHORIZED', authorizedUntil: '2027-12-31' });
    expect(v.status).toBe(201);
    expect((await pr.post(`/api/v1/vendors/${v.body.id}/prices`, { items: [{ sku: 'SIEM-EPS-1K', description: 'SIEM 1000 EPS 1 th', unit: 'lisensi', currency: 'USD', unitCost: 10000, validFrom: '2026-01-01' }] })).status).toBe(400);
    const p = await pr.post(`/api/v1/vendors/${v.body.id}/prices`, { items: [
      { sku: 'SIEM-EPS-1K', description: 'SIEM 1000 EPS 1 th', unit: 'lisensi', currency: 'USD', unitCost: 10000, fxRateToIdr: 16000, validFrom: '2026-01-01', validUntil: '2027-01-31' },
      { sku: 'COLLECTOR', description: 'Collector appliance', unit: 'unit', unitCost: 20_000_000, validFrom: '2025-01-01', validUntil: '2025-12-31' }] });
    expect(p.status).toBe(201);
    const bom = await pr.post('/api/v1/pricing/bom', { lines: [{ priceItemId: p.body.items[0].id, qty: 1 }, { priceItemId: p.body.items[1].id, qty: 2 }], targetMarginPct: 20 });
    expect(bom.body.totalCost).toBe(160_000_000 + 40_000_000);
    expect(bom.body.totalSellingPrice).toBe(250_000_000);
    expect(bom.body.grossMarginPct).toBe(20);
    expect(bom.body.lines[1].warnings.join(' ')).toMatch(/kedaluwarsa/);
    expect((await api(app, T.sales).post('/api/v1/pricing/bom', { lines: [{ priceItemId: p.body.items[0].id, qty: 1 }] })).status).toBe(403);
  });

  it('CTI tier & ISO/PDP sizing follow BRD formulas', async () => {
    const pr = api(app, T.presales);
    const b = await api(app, T.sales).post('/api/v1/customers', { legalName: 'PT Bank Demo CTI', industry: 'banking', clientTier: 'A' });
    const o = await api(app, T.sales).post('/api/v1/opportunities', { customerId: b.body.id, name: 'CTI 2026', serviceCategory: 'CTI' });
    const cti = await pr.post('/api/v1/assessments', { customerId: b.body.id, opportunityId: o.body.id, serviceType: 'CTI',
      answers: { domains: 12, subsidiaries: 1, darkWebMonitoring: true, rfiPerMonth: 4, siemIntegration: true, contractMonths: 12 } });
    const c = await pr.post(`/api/v1/assessments/${cti.body.id}/calculate`, {});
    expect(c.status).toBe(200);
    expect(c.body.result.totalScore).toBe(6);
    expect(c.body.result.tier.key).toBe('enterprise');
    expect(c.body.result.monthlyTotal).toBe(120_000_000);
    expect(c.body.result.contractValue).toBe(120_000_000 * 12 + 27_500_000);
    const grc = await pr.post('/api/v1/assessments', { customerId: b.body.id, opportunityId: o.body.id, serviceType: 'GRC',
      answers: { iso: { frameworks: ['iso27001'], employees: 120, locations: 2, scope: 'company', maturity: '2', serviceType: 'full' }, pdp: { dpoHours: 'h8_20', dpiaCount: 1, months: 12 } } });
    const g = await pr.post(`/api/v1/assessments/${grc.body.id}/calculate`, {});
    expect(g.body.result.technicalMd).toBe(43); // (35 + 2×2) × 1.0 × 1.1 × 1.0 = 42.9 → 43
    expect(g.body.result.pdpValue).toBe(35_000_000 * 12 + 20_000_000);
    await pr.post(`/api/v1/assessments/${g.body.id}/review`, {});
    const sc = await pr.post('/api/v1/pricing/scenarios', { opportunityId: o.body.id, assessmentId: g.body.id, label: 'ISO+PDP', input: { clientTier: 'A' } });
    expect(sc.status).toBe(201);
    expect(sc.body.result.boq.A_humanResources.total).toBeGreaterThan(0);
    expect(sc.body.result.prices.floor).toBe(Math.round(sc.body.result.boq.totalCost / 0.8) + 440_000_000);
  });

  it('pricing simulation covers discount, effort, FX, staffing mix and competitor gap', async () => {
    const r = await api(app, T.presales).post('/api/v1/pricing/simulate', { base: { clientTier: 'A', hr: [{ role: 'pm', md: 3 }, { role: 'lead', md: 5 }, { role: 'senior', md: 8 }, { role: 'junior', md: 4 }] },
      competitorPrice: 30_000_000 });
    expect(r.status).toBe(200);
    const dims = new Set(r.body.rows.map((x: any) => x.dimension));
    for (const d of ['base', 'discountPct', 'effortFactor', 'fxIndex', 'staffingMix']) expect(dims.has(d)).toBe(true);
    const d20 = r.body.rows.find((x: any) => x.dimension === 'discountPct' && x.value === 20);
    expect(d20.marginHold).toBe(true);
    const fxUp = r.body.rows.find((x: any) => x.dimension === 'fxIndex' && x.value === 1.1);
    const base = r.body.rows[0];
    expect(fxUp.sellingPrice).toBeGreaterThan(base.sellingPrice);
    expect(base.vsCompetitorPct).not.toBeNull();
  });
});

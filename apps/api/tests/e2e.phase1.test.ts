/**
 * Phase 1 acceptance gate — end-to-end terhadap PostgreSQL nyata.
 * Nomor [#n] merujuk ke Master Prompt §X (Testing & Acceptance Criteria).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { resetBreakers } from '../src/modules/ai/gateway.js';
import { SEED_PW, api, freshDb, login, makeApp } from './helpers.js';

let sql: Sql;
let app: FastifyInstance;
const fetchCalls: { url: string; body: string }[] = [];
let aiBehaviour: Record<string, 'ok' | 'fail500' | 'fail429' | 'timeout'> = {};

const fakeFetch = async (url: string, init: RequestInit) => {
  fetchCalls.push({ url, body: String(init.body) });
  const prov = url.includes('anthropic') ? 'anthropic' : url.includes('openai.com') ? 'openai' : url.includes('googleapis') ? 'gemini'
    : url.includes('mistral') ? 'mistral' : url.includes('groq') ? 'groq' : 'openrouter';
  const mode = aiBehaviour[prov] ?? 'fail500';
  if (mode === 'fail500') return new Response('{"error":"upstream"}', { status: 500 });
  if (mode === 'fail429') return new Response('{"error":"rate"}', { status: 429 });
  if (mode === 'timeout') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  if (prov === 'anthropic') return Response.json({ content: [{ type: 'text', text: `draft from ${prov}` }], usage: { input_tokens: 10, output_tokens: 5 } });
  if (prov === 'gemini') return Response.json({ candidates: [{ content: { parts: [{ text: `draft from ${prov}` }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } });
  return Response.json({ choices: [{ message: { content: `draft from ${prov}` } }], usage: { prompt_tokens: 8, completion_tokens: 3 } });
};

const T: Record<string, string> = {};
const ctx: Record<string, any> = {};

beforeAll(async () => {
  sql = await freshDb();
  app = await makeApp(sql, fakeFetch as never);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY']) process.env[k] = `test-${k}`;
});
afterAll(async () => { await app.close(); await sql.end(); });

describe('Auth & security baseline', () => {
  it('rejects unauthenticated requests (401)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/customers' });
    expect(r.statusCode).toBe(401);
  });

  it('forces password change on first login before any other API', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'sales@defendit360.com', password: SEED_PW } });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.forcePasswordChange).toBe(true);
    const blocked = await api(app, r.json().token).get('/api/v1/customers');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const weak = await api(app, r.json().token).post('/api/v1/auth/change-password', { currentPassword: SEED_PW, newPassword: 'short' });
    expect(weak.status).toBe(400);
  });

  it('logs in all actors (password rotated, old sessions revoked)', async () => {
    const users = { sales: 'sales@defendit360.com', presales: 'presales@defendit360.com', mgr: 'salesmanager@defendit360.com', vp: 'vp@defendit360.com',
      dir: 'direktur@defendit360.com', fin: 'finance@defendit360.com', aud: 'auditor@defendit360.com', admin: 'companyadmin@defendit360.com' };
    for (const [k, e] of Object.entries(users)) T[k] = await login(app, e);
    const me = await api(app, T.sales).get('/api/v1/auth/me');
    expect(me.body.role).toBe('account_manager');
    expect(me.body.permissions).not.toContain('pricing.view_cost');
  });

  it('locks account after 5 failed logins', async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'legal@defendit360.com', password: 'wrong-pass' } });
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'legal@defendit360.com', password: SEED_PW } });
    expect(r.statusCode).toBe(423);
  });
});

describe('Phase 1 commercial flow', () => {
  it('[#1] sales registers customer (dedup enforced) and opportunity', async () => {
    const s = api(app, T.sales);
    const c = await s.post('/api/v1/customers', { legalName: 'PT Bank Demo Nusantara Tbk', industry: 'banking', clientTier: 'A', npwp: '01.234.567.8-901.000', city: 'Jakarta' });
    expect(c.status).toBe(201);
    expect(c.body.code).toBe('CUS-00001');
    ctx.customer = c.body;
    const dup = await s.post('/api/v1/customers', { legalName: 'PT. Bank Demo Nusantara, Tbk', industry: 'banking' });
    expect(dup.status).toBe(409);
    const ct = await s.post(`/api/v1/customers/${c.body.id}/contacts`, { fullName: 'Ibu Rina', contactRole: 'technical', isDecisionMaker: true, email: 'rina@demo.co.id' });
    expect(ct.status).toBe(201);
    const o = await s.post('/api/v1/opportunities', { customerId: c.body.id, name: 'VAPT Internet Banking 2026', serviceCategory: 'VAPT', amountEstimate: 300_000_000 });
    expect(o.status).toBe(201);
    expect(o.body.code).toMatch(/^OPP-\d{4}-0001$/);
    ctx.opp = o.body;
    const bad = await s.post(`/api/v1/opportunities/${o.body.id}/stage`, { stage: 'WON' });
    expect(bad.status).toBe(422);
    for (const st of ['QUALIFIED', 'SCOPING']) expect((await s.post(`/api/v1/opportunities/${o.body.id}/stage`, { stage: st })).status).toBe(200);
    const noScenario = await s.post(`/api/v1/opportunities/${o.body.id}/stage`, { stage: 'PROPOSAL' });
    expect(noScenario.status).toBe(422);
  });

  it('[#13] tenant isolation — other tenant cannot see the customer', async () => {
    const [t2] = await sql`INSERT INTO tenants (code, name) VALUES ('OTHER', 'Other Co') RETURNING id`;
    await sql`INSERT INTO users (tenant_id, email, full_name, password_hash, role, force_password_change)
              VALUES (${t2.id}, 'am@other.co', 'Other AM', ${await bcrypt.hash(SEED_PW, 4)}, 'account_manager', false)`;
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { tenant: 'OTHER', email: 'am@other.co', password: SEED_PW } });
    const o = api(app, r.json().token);
    expect((await o.get(`/api/v1/customers/${ctx.customer.id}`)).status).toBe(404);
    expect((await o.get('/api/v1/customers')).body.items).toHaveLength(0);
    expect((await o.post('/api/v1/opportunities', { customerId: ctx.customer.id, name: 'steal', serviceCategory: 'VAPT' })).status).toBe(404);
  });

  it('[#2] pre-sales fills scoping and gets reviewed effort estimate', async () => {
    const p = api(app, T.presales);
    const withPw = await p.post('/api/v1/assessments', { customerId: ctx.customer.id, opportunityId: ctx.opp.id, serviceType: 'VAPT', answers: { password: 'x' } });
    expect(withPw.status).toBe(400);
    const a = await p.post('/api/v1/assessments', { customerId: ctx.customer.id, opportunityId: ctx.opp.id, serviceType: 'VAPT',
      answers: { web: [{ name: 'Internet Banking', complexity: 'complex', roles: 3, apiEndpoints: 40, handlesFinancialData: true }],
        mobile: [{ name: 'Mobile Banking', platform: 'dual', feature: 'fintech', includeBackend: true }],
        webMethod: 'grey', webAuth: 'mfa', compliance: 'ojk', workLocation: 'hybrid', assessmentWindow: 'weekday 20:00-04:00', reportingStandard: 'OWASP + SEOJK' } });
    expect(a.status).toBe(201);
    expect(a.body.completeness).toBe(100);
    const calc = await p.post(`/api/v1/assessments/${a.body.id}/calculate`);
    expect(calc.status).toBe(200);
    expect(calc.body.status).toBe('ENGINEER_REVIEW_REQUIRED');
    expect(calc.body.result.totalMd).toBeGreaterThan(20);
    // Sales tidak boleh mereview
    expect((await api(app, T.sales).post(`/api/v1/assessments/${a.body.id}/review`, {})).status).toBe(403);
    const rv = await p.post(`/api/v1/assessments/${a.body.id}/review`, { note: 'Sesuai scope RFP' });
    expect(rv.status).toBe(200);
    expect(rv.body.status).toBe('REVIEWED');
    ctx.assessment = rv.body;
  });

  it('[#3] pricing engine computes BoQ, price and margin from the reviewed assessment', async () => {
    const p = api(app, T.presales);
    const sc = await p.post('/api/v1/pricing/scenarios', { opportunityId: ctx.opp.id, assessmentId: ctx.assessment.id, label: 'Standard', input: { clientTier: 'A' } });
    expect(sc.status).toBe(201);
    const team = ctx.assessment.result.team;
    const expectedHr = team.pm * 1_500_000 + team.lead * 2_000_000 + team.senior * 1_000_000 + team.junior * 500_000;
    const r = sc.body.result;
    expect(r.boq.A_humanResources.total).toBe(expectedHr);
    expect(r.boq.totalCost).toBe(expectedHr + 2_000_000);
    expect(r.prices.floor).toBe(Math.round(r.boq.totalCost / 0.8));
    expect(r.prices.standard).toBe(Math.round(r.boq.totalCost / 0.65));
    expect(r.grossMarginPct).toBeCloseTo(35, 1);
    ctx.scenario = sc.body;
    // Sales (tanpa view_cost) mendapat hasil tanpa cost/margin
    const s = await api(app, T.sales).post('/api/v1/pricing/calculate', { clientTier: 'A', hr: [{ role: 'senior', md: 5 }] });
    expect(JSON.stringify(s.body)).not.toMatch(/totalCost|floor|grossMargin|markup/);
    const blocked = await api(app, T.sales).get(`/api/v1/pricing/scenarios/compare?ids=${sc.body.id},${sc.body.id}`);
    expect(blocked.status).toBe(403);
  });

  it('[#6] quotation cannot be issued without complete approval', async () => {
    const s = api(app, T.sales);
    const q = await s.post('/api/v1/quotations', { opportunityId: ctx.opp.id, scenarioId: ctx.scenario.id, title: 'VAPT Internet & Mobile Banking', discountPct: 10 },
      { 'idempotency-key': 'create-q-1' });
    expect(q.status).toBe(201);
    expect(q.body.number).toMatch(/^001\/DEIT-RCS\/[IVX]+\/\d{4}$/);
    expect(q.body.internalCost).toBeUndefined(); // [#14] redacted for account manager
    const replay = await s.post('/api/v1/quotations', { opportunityId: ctx.opp.id, scenarioId: ctx.scenario.id, title: 'VAPT Internet & Mobile Banking', discountPct: 10 },
      { 'idempotency-key': 'create-q-1' });
    expect(replay.body.id).toBe(q.body.id); // [#17]
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM quotations`;
    expect(n).toBe(1);
    ctx.q = q.body;
    expect((await s.post(`/api/v1/quotations/${q.body.id}/issue`)).status).toBe(422);
    const opp = await s.get(`/api/v1/opportunities/${ctx.opp.id}`);
    expect(opp.body.opportunity.stage).toBe('PROPOSAL');
  });

  it('[#4][#16][#17] discount beyond manager authority escalates; SoD, four-eyes, idempotent decisions', async () => {
    const s = api(app, T.sales);
    const sub = await s.post(`/api/v1/quotations/${ctx.q.id}/submit`, {}, { 'idempotency-key': 'submit-1' });
    expect(sub.status).toBe(200);
    expect(sub.body.reasons.find((r: any) => r.type === 'DISCOUNT').level).toBe(2);
    expect(sub.body.requiredLevel).toBe(2);
    expect(sub.body.steps.map((x: any) => x.level)).toEqual([1, 2]);
    const again = await s.post(`/api/v1/quotations/${ctx.q.id}/submit`, {}, { 'idempotency-key': 'submit-1' });
    expect(again.body.approvalRequestId).toBe(sub.body.approvalRequestId);
    ctx.ar = sub.body.approvalRequestId;

    // Account manager tidak punya approval.decide
    expect((await s.post(`/api/v1/approvals/${ctx.ar}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    // VP mengambil step Manager (boleh: level lebih tinggi), lalu four-eyes mencegah VP memutus step VP juga
    const mgr = api(app, T.mgr);
    const inbox = await mgr.get('/api/v1/approvals');
    expect(inbox.body.items.map((i: any) => i.id)).toContain(ctx.ar);
    expect((await mgr.post(`/api/v1/approvals/${ctx.ar}/decide`, { decision: 'REJECT' })).status).toBe(400); // alasan wajib
    const d1 = await mgr.post(`/api/v1/approvals/${ctx.ar}/decide`, { decision: 'APPROVE', comment: 'OK' }, { 'idempotency-key': 'dec-1' });
    expect(d1.body.finalStatus).toBe('PENDING');
    const d1r = await mgr.post(`/api/v1/approvals/${ctx.ar}/decide`, { decision: 'APPROVE', comment: 'OK' }, { 'idempotency-key': 'dec-1' });
    expect(d1r.headers['idempotent-replay']).toBe('true');
    const step2ByMgr = await mgr.post(`/api/v1/approvals/${ctx.ar}/decide`, { decision: 'APPROVE' });
    expect(step2ByMgr.status).toBe(403);
    const d2 = await api(app, T.vp).post(`/api/v1/approvals/${ctx.ar}/decide`, { decision: 'APPROVE', comment: 'Diskon 10% wajar untuk BPD' });
    expect(d2.body.finalStatus).toBe('APPROVED');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM approval_decisions WHERE request_id = ${ctx.ar}`;
    expect(n).toBe(2);
    await expect(sql`UPDATE approval_decisions SET comment = 'tamper'`).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_events`).rejects.toThrow(/append-only/);
  });

  it('material change after approval forces re-approval', async () => {
    const s = api(app, T.sales);
    const cur = await s.get(`/api/v1/quotations/${ctx.q.id}`);
    expect(cur.body.status).toBe('APPROVED');
    const stale = await s.put(`/api/v1/quotations/${ctx.q.id}`, { discountPct: 5, rowVersion: 999 });
    expect(stale.status).toBe(409);
    const ed = await s.put(`/api/v1/quotations/${ctx.q.id}`, { discountPct: 5, rowVersion: cur.body.rowVersion });
    expect(ed.status).toBe(200);
    expect(ed.body.status).toBe('DRAFT');
    expect(ed.body.revision).toBe(1);
    const [old] = await sql`SELECT status FROM approval_requests WHERE id = ${ctx.ar}`;
    expect(old.status).toBe('SUPERSEDED');
    expect((await s.post(`/api/v1/quotations/${ctx.q.id}/issue`)).status).toBe(422);
  });

  it('[#5] approved quotation issues an offer letter with correct prices and no internal data', async () => {
    const s = api(app, T.sales);
    const sub = await s.post(`/api/v1/quotations/${ctx.q.id}/submit`);
    expect(sub.body.requiredLevel).toBe(2);
    await api(app, T.mgr).post(`/api/v1/approvals/${sub.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
    await api(app, T.dir).post(`/api/v1/approvals/${sub.body.approvalRequestId}/decide`, { decision: 'APPROVE' });
    const iss = await s.post(`/api/v1/quotations/${ctx.q.id}/issue`);
    expect(iss.status).toBe(200);
    const q = (await api(app, T.presales).get(`/api/v1/quotations/${ctx.q.id}`)).body;
    const list = ctx.scenario.result.listPrice;
    expect(q.subtotal).toBe(list);
    expect(q.discountAmount).toBe(Math.round(list * 0.05 * 100) / 100);
    expect(q.taxAmount).toBe(Math.round(q.totalBeforeTax * 0.11 * 100) / 100);
    expect(q.grandTotal).toBeCloseTo(q.totalBeforeTax + q.taxAmount, 2);
    const doc = await app.inject({ method: 'GET', url: `/api/v1/quotations/${ctx.q.id}/document`, headers: { authorization: `Bearer ${T.presales}` } });
    expect(doc.statusCode).toBe(200);
    const fmt = (n: number) => 'Rp ' + n.toLocaleString('id-ID', { maximumFractionDigits: 0 });
    expect(doc.body).toContain(fmt(q.grandTotal));
    expect(doc.body).toContain('Rev.1');
    expect(doc.body).not.toMatch(/DRAFT —/);
    expect(doc.body).not.toContain(fmt(q.internalCost));
    expect(doc.body).not.toContain(fmt(q.floorPrice));
    expect(doc.body).not.toMatch(/internalCost|floorPrice|grossMargin|biaya internal/i);
    ctx.qFull = q;
  });

  it('[#7][#8][#14] customer sees & accepts via portal; internal BoQ never exposed', async () => {
    const s = api(app, T.sales);
    expect((await s.post(`/api/v1/quotations/${ctx.q.id}/mark-sent`, { channel: 'portal' })).status).toBe(200);
    const [tenant] = await sql`SELECT id FROM tenants WHERE code = 'DEIT'`;
    await sql`INSERT INTO users (tenant_id, email, full_name, password_hash, role, customer_id, force_password_change)
              VALUES (${tenant.id}, 'pic@demo.co.id', 'PIC Customer', ${await bcrypt.hash(SEED_PW, 4)}, 'customer_user', ${ctx.customer.id}, false)`;
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'pic@demo.co.id', password: SEED_PW } });
    const c = api(app, r.json().token);
    expect((await c.get('/api/v1/quotations')).status).toBe(403);
    expect((await c.get(`/api/v1/quotations/${ctx.q.id}`)).status).toBe(403);
    expect((await c.get(`/api/v1/pricing/scenarios/compare?ids=${ctx.scenario.id},${ctx.scenario.id}`)).status).toBe(403);
    const list = await c.get('/api/v1/portal/quotations');
    expect(list.body.items).toHaveLength(1);
    const one = await c.get(`/api/v1/portal/quotations/${ctx.q.id}`);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toMatch(/internalCost|floorPrice|grossMarginPct|scenarioId/);
    expect((await c.post(`/api/v1/portal/quotations/${ctx.q.id}/respond`, { response: 'ACCEPT' })).status).toBe(400);
    const acc = await c.post(`/api/v1/portal/quotations/${ctx.q.id}/respond`, { response: 'ACCEPT', acknowledgement: true, note: 'Setuju, PO menyusul' });
    expect(acc.status).toBe(200);
    expect(acc.body.contractingHandover).toBe('PENDING_CONTRACT');
    const won = await s.post(`/api/v1/opportunities/${ctx.opp.id}/stage`, { stage: 'WON' });
    expect(won.status).toBe(200);
    const notes = await api(app, T.mgr).get('/api/v1/notifications');
    expect(notes.body.items.some((n: any) => n.kind === 'CUSTOMER_RESPONSE')).toBe(true);
  });

  it('margin below hold threshold requires Director (MARGIN_EXCEPTION)', async () => {
    const s = api(app, T.sales);
    const o = await s.post('/api/v1/opportunities', { customerId: ctx.customer.id, name: 'VAPT Network', serviceCategory: 'VAPT' });
    const sc = await api(app, T.presales).post('/api/v1/pricing/scenarios', { opportunityId: o.body.id, label: 'Low',
      input: { clientTier: 'B', hr: [{ role: 'pm', md: 7 }, { role: 'lead', md: 13 }, { role: 'senior', md: 40 }, { role: 'junior', md: 10 }], selectedBasis: 'manual', manualPrice: 100_000_000 } });
    expect(sc.body.result.flags.marginHold).toBe(true);
    const q = await s.post('/api/v1/quotations', { opportunityId: o.body.id, scenarioId: sc.body.id, title: 'VAPT Network' });
    const sub = await s.post(`/api/v1/quotations/${q.body.id}/submit`);
    expect(sub.body.requiredLevel).toBe(3);
    expect(sub.body.reasons.map((r: any) => r.type)).toEqual(expect.arrayContaining(['MARGIN_EXCEPTION', 'BELOW_FLOOR']));
  });

  it('[#16] every approval & state change is in the audit trail', async () => {
    const a = await api(app, T.aud).get(`/api/v1/audit?entityType=quotation&entityId=${ctx.q.id}`);
    const actions = a.body.items.map((x: any) => x.action);
    for (const act of ['quotation.create', 'quotation.submit', 'quotation.update', 'quotation.issue', 'quotation.sent', 'portal.quotation_accept']) expect(actions).toContain(act);
    const ap = await api(app, T.aud).get('/api/v1/audit?entityType=approval_request');
    expect(ap.body.items.filter((x: any) => x.action === 'approval.approve').length).toBeGreaterThanOrEqual(4);
    expect((await api(app, T.sales).get('/api/v1/audit')).status).toBe(403);
  });

  it('dashboard KPIs derive from real transactions', async () => {
    const d = await api(app, T.vp).get('/api/v1/dashboard');
    const k = Object.fromEntries(d.body.kpis.map((x: any) => [x.key, x.value]));
    expect(k.win_rate).toBe(100);
    expect(k.accepted_value).toBe(ctx.qFull.totalBeforeTax);
  });

  it('policy activation is maker-checker (finance drafts, director activates)', async () => {
    const f = api(app, T.fin);
    const p = await f.post('/api/v1/policies', { kind: 'DOA', code: 'DOA-TEST', title: 'Test DoA', params: { sequential: true, slaHours: {}, rules: [] }, effectiveFrom: '2026-11-01' });
    expect(p.status).toBe(201);
    expect((await f.post(`/api/v1/policies/${p.body.id}/activate`)).status).toBe(403);
    const before = await sql`SELECT code FROM policies WHERE kind = 'DOA' AND is_current`;
    expect(before[0].code).toBe('DOA-MP-2026');
    // tidak diaktifkan agar tes lain tidak terpengaruh; cek hanya izin
  });
});

describe('AI gateway — multi-provider failover', () => {
  it('lists 7 providers with key status', async () => {
    const r = await api(app, T.sales).get('/api/v1/ai/providers');
    expect(r.body.items.map((p: any) => p.provider)).toEqual(['anthropic', 'openai', 'gemini', 'mistral', 'groq', 'openrouter', 'custom']);
    expect(r.body.readyCount).toBe(6);
  });

  it('fails over anthropic(500) → openai(429) → gemini(ok); redacts PII before sending', async () => {
    resetBreakers();
    aiBehaviour = { anthropic: 'fail500', openai: 'fail429', gemini: 'ok' };
    fetchCalls.length = 0;
    const r = await api(app, T.sales).post('/api/v1/ai/complete', { feature: 'opportunity_brief', opportunityId: ctx.opp.id,
      prompt: 'Hubungi rina@demo.co.id, server 10.20.30.40' });
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe('gemini');
    expect(r.body.attempts.map((a: any) => [a.provider, a.ok])).toEqual([['anthropic', false], ['openai', false], ['gemini', true]]);
    expect(r.body.requiresHumanReview).toBe(true);
    expect(fetchCalls.every((c) => !c.body.includes('rina@demo.co.id') && !c.body.includes('10.20.30.40'))).toBe(true);
    expect(fetchCalls.some((c) => /internalCost|floorPrice|grossMargin/.test(c.body))).toBe(false);
    const [log] = await sql`SELECT * FROM ai_calls WHERE status = 'SUCCESS' ORDER BY id DESC LIMIT 1`;
    expect(log.provider).toBe('gemini');
    expect(log.redactions).toBeGreaterThanOrEqual(2);
  });

  it('circuit breaker opens after 3 failures and skips provider', async () => {
    resetBreakers();
    aiBehaviour = { anthropic: 'timeout', openai: 'ok' };
    for (let i = 0; i < 3; i++) await api(app, T.sales).post('/api/v1/ai/complete', { feature: 'chat', prompt: 'halo' });
    const r = await api(app, T.sales).post('/api/v1/ai/complete', { feature: 'chat', prompt: 'halo' });
    expect(r.body.provider).toBe('openai');
    expect(r.body.attempts[0].skipped).toBe('circuit open');
  });

  it('returns 503 with attempt trail when all providers fail; disabled provider skipped', async () => {
    resetBreakers();
    aiBehaviour = {};
    await api(app, T.admin).patch('/api/v1/ai/providers/groq', { enabled: false });
    const r = await api(app, T.sales).post('/api/v1/ai/complete', { feature: 'chat', prompt: 'halo' });
    expect(r.status).toBe(503);
    expect(r.body.attempts.find((a: any) => a.provider === 'groq').skipped).toBe('disabled');
    expect((await api(app, T.sales).patch('/api/v1/ai/providers/groq', { enabled: true })).status).toBe(403);
  });

  it('admin live-test endpoint targets a single provider', async () => {
    resetBreakers();
    aiBehaviour = { mistral: 'ok' };
    const r = await api(app, T.admin).post('/api/v1/ai/providers/mistral/test');
    expect(r.body.ok).toBe(true);
    expect(r.body.model).toBe('mistral-small-latest');
  });
});

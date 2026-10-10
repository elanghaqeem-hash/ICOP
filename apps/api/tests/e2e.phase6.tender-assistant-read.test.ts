import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { api, freshDb, login, makeApp, NEW_PW } from './helpers.js';

let sql: Sql;
let app: FastifyInstance;
let internal: ReturnType<typeof api>;
let outsider: ReturnType<typeof api>;
let tenderA = '', tenderB = '';
let docId='';
const previousPolicy=process.env.MFA_POLICY;

beforeAll(async()=>{
 process.env.MFA_POLICY='off';
 sql=await freshDb();app=await makeApp(sql);
 internal=api(app,await login(app,'tender@defendit360.com'));
 const a=await internal.post('/api/v1/tenders',{
  title:'Managed SOC 24x7 Phase6B source A',
  procuringEntity:'Badan Pengadaan Phase6A',
  submissionDeadline:new Date(Date.now()+7*864e5).toISOString(),
 });
 if(a.status!==201)throw new Error('Tender A '+JSON.stringify(a.body));
 tenderA=a.body.id;

 const req=await internal.post(`/api/v1/tenders/${tenderA}/requirements`,{
  category:'TECHNICAL',mandatory:true,
  requirement:'SLA response insiden kritis maksimal 30 menit, pelaporan SIEM setiap hari',
 });
 if(req.status!==201)throw new Error('Requirement '+JSON.stringify(req.body));

 const [t]=await sql`SELECT tenant_id FROM tenders WHERE id=${tenderA}`;
 const [d]=await sql`INSERT INTO tender_documents
   (tenant_id,tender_id,kind,filename,mime,size_bytes,sha256,storage_path,extraction_status,extracted_text,page_count)
   VALUES (${t.tenantId},${tenderA},'RKS','RKS Alpha.pdf','application/pdf',64,
   ${'a'.repeat(64)},'/tenant-a/rks.pdf','DONE',
   'Bab Teknis: layanan SOC 24x7 dan respon insiden kritis maksimal 30 menit.\nBab Pelaporan: dashboard SIEM harian.',2)
   RETURNING id`;
 docId=d.id;
 const q=await internal.post(`/api/v1/tenders/${tenderA}/clarifications`,{
   question:'Apakah respons insiden SOC memerlukan kontak telepon 24x7?',
 });
 if(q.status!==201)throw new Error('Clarification '+JSON.stringify(q.body));
 const answer=await internal.patch(`/api/v1/tenders/${tenderA}/clarifications/${q.body.id}`,{
   status:'ANSWERED',answer:'Panitia menyetujui eskalasi insiden melalui telepon 24x7 dan email notifikasi.'
 });
 if(answer.status!==200)throw new Error('Answered '+JSON.stringify(answer.body));

 const [b]=await sql`INSERT INTO tenants(code,name) VALUES('SRCB','Separate Tender Client') RETURNING id`;
 const hash=await bcrypt.hash(NEW_PW,12);
 await sql`INSERT INTO users(tenant_id,email,full_name,role,password_hash,force_password_change)
  VALUES(${b.id},'tender-b@example.invalid','Other Tender Admin','company_admin',${hash},false)`;
 const [second]=await sql`INSERT INTO tenders(tenant_id,code,title,procuring_entity,source)
  VALUES(${b.id},'T-B-01','Secret SIEM Beta RKS','Tenant B procurement','manual') RETURNING id`;
 tenderB=second.id;
 await sql`INSERT INTO tender_documents(tenant_id,tender_id,kind,filename,mime,size_bytes,sha256,storage_path,extraction_status,extracted_text)
  VALUES(${b.id},${tenderB},'RKS','RKS Tenant B.pdf','application/pdf',50,
    ${'b'.repeat(64)},'/tenant-b/rks.pdf','DONE','Rahasia harga vendor Beta 4321 persen')`;
 const loginB=await app.inject({method:'POST',url:'/api/v1/auth/login',
   payload:{tenant:'SRCB',email:'tender-b@example.invalid',password:NEW_PW}});
 if(loginB.statusCode!==200)throw new Error(loginB.body);
 outsider=api(app,loginB.json().token);
},60000);
afterAll(async()=>{if(app)await app.close();if(sql)await sql.end();if(previousPolicy===undefined)delete process.env.MFA_POLICY;else process.env.MFA_POLICY=previousPolicy;});

describe('Phase 6B1: sourced tender readiness and evidence retrieval',()=>{
 it('reports deterministic readiness with actual mandatory gaps and deadlines',async()=>{
  const r=await internal.get(`/api/v1/tenders/${tenderA}/assistant/brief`);
  expect(r.status).toBe(200);
  expect(r.body.source).toBe('DETERMINISTIC');
  expect(r.body.requiresHumanReview).toBe(true);
  expect(r.body.requirements.mandatoryOpen.length).toBe(1);
  expect(r.body.requirements.byStatus.UNREVIEWED).toBe(1);
  expect(r.body.documents.textReady).toBe(1);
  expect(r.body.actions.map((x:any)=>x.text).join(' ')).toMatch(/belum ditinjau/);
 });
 it('returns actual RKS, requirement and answered aanwijzing snippets with source labels',async()=>{
  const r=await internal.post(`/api/v1/tenders/${tenderA}/assistant/search`,{
    question:'SLA respons insiden 24x7 panitia',
  });
  expect(r.status).toBe(200);
  expect(r.body.mode).toBe('keyword');
  expect(r.body.answer).toBeNull();
  expect(r.body.sources.map((x:any)=>x.kind)).toEqual(expect.arrayContaining(['RKS','REQUIREMENT','AANWIJZING']));
  expect(JSON.stringify(r.body)).toContain('30 menit');
  expect(JSON.stringify(r.body)).not.toContain('Rahasia harga vendor Beta');
  expect(r.body.sources.every((x:any)=>x.link===`/tenders/${tenderA}`)).toBe(true);
 });
 it('fails safely for irrelevant/stopword queries; no synthetic compliance assertion',async()=>{
  const r=await internal.post(`/api/v1/tenders/${tenderA}/assistant/search`,{
    question:'xyzunexpectedterm qqqnothere',
  });
  expect(r.status).toBe(200);
  expect(r.body.grounded).toBe(false);
  expect(r.body.answer).toBeNull();
  expect(r.body.sources).toEqual([]);
  expect(r.body.message).toMatch(/Tidak ditemukan/);
  const bad=await internal.post(`/api/v1/tenders/${tenderA}/assistant/search`,{question:'hai'});
  expect(bad.status).toBe(400);
 });
 it('prevents cross-tenant document search and direct tender ID lookup for admins',async()=>{
  const read=await outsider.get(`/api/v1/tenders/${tenderA}/assistant/brief`);
  expect(read.status).toBe(404);
  const search=await outsider.post(`/api/v1/tenders/${tenderA}/assistant/search`,{
   question:'SOC SIEM vendor',
  });
  expect(search.status).toBe(404);
  const own=await outsider.post(`/api/v1/tenders/${tenderB}/assistant/search`,{
   question:'Rahasia harga vendor Beta',
  });
  expect(own.status).toBe(200);
  expect(JSON.stringify(own.body)).toContain('Rahasia harga vendor Beta');
  expect(JSON.stringify(own.body)).not.toContain('30 menit');
 });
 it('does not leak private extracted RKS outside tenant through metadata',async()=>{
  const r=await internal.post(`/api/v1/tenders/${tenderA}/assistant/search`,{
    question:'Rahasia harga vendor Beta',
  });
  expect(r.status).toBe(200);
  expect(r.body.sources).toEqual([]);
  const [doc]=await sql`SELECT id FROM tender_documents WHERE id=${docId} AND tender_id=${tenderA}`;
  expect(doc.id).toBe(docId);
 });
});

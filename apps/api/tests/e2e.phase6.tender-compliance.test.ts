import {beforeAll,afterAll,describe,expect,it} from 'vitest';
import bcrypt from 'bcryptjs';
import type {FastifyInstance} from 'fastify';
import type {Sql} from '../src/db.js';
import {api,freshDb,login,makeApp,NEW_PW} from './helpers.js';

let sql:Sql,app:FastifyInstance;
let maker:ReturnType<typeof api>,checker:ReturnType<typeof api>,auditor:ReturnType<typeof api>,outside:ReturnType<typeof api>;
let tenderId='',goodId='',badId='',factId='',goodSuggestion='',badSuggestion='';
const q:string[]=[];const prompts:string[]=[];
const oldPolicy=process.env.MFA_POLICY,oldKey=process.env.ANTHROPIC_API_KEY;
const aiFetch=async(_url:string,init:RequestInit)=>{
 prompts.push(String(init.body??''));const text=q.shift();
 if(!text)return new Response('{"error":"No AI fixture"}',{status:500});
 return Response.json({content:[{type:'text',text}],usage:{input_tokens:10,output_tokens:10}});
};
beforeAll(async()=>{
 process.env.MFA_POLICY='off';process.env.ANTHROPIC_API_KEY='integration-test-only';
 sql=await freshDb();app=await makeApp(sql,aiFetch as never);
 maker=api(app,await login(app,'tender@defendit360.com'));
 checker=api(app,await login(app,'sales@defendit360.com'));
 auditor=api(app,await login(app,'auditor@defendit360.com'));
 const [{id:tenant}]=await sql`SELECT id FROM tenants WHERE code='DEIT'`;
 const [{id:creator}]=await sql`SELECT id FROM users WHERE tenant_id=${tenant} AND email='tender@defendit360.com'`;
 const [t]=await sql`INSERT INTO tenders
   (tenant_id,code,title,procuring_entity,source,submission_deadline,created_by)
   VALUES(${tenant},'P6B2-001','VAPT ISO tender Phase6B2','Procurement Unit','manual',
     now()+interval '20 days',${creator}) RETURNING id`;
 tenderId=t.id;
 const reqs=await sql`INSERT INTO tender_requirements
  (tenant_id,tender_id,ref_code,category,requirement,mandatory,origin)
  VALUES(${tenant},${tenderId},'QUAL-001','QUALIFICATION',
      'Penyedia wajib punya sertifikat ISO/IEC 27001 yang masih berlaku',true,'MANUAL'),
    (${tenant},${tenderId},'TECH-001','TECHNICAL',
      'Pelaksana wajib memiliki personel bersertifikat GCIH tahun 2026',true,'MANUAL'),
    (${tenant},${tenderId},'COMM-001','COMMERCIAL',
      'Harga penawaran minimal sepuluh miliar rupiah',true,'MANUAL')
  RETURNING id,ref_code`;
 goodId=reqs.find(r=>r.refCode==='QUAL-001')!.id;
 badId=reqs.find(r=>r.refCode==='TECH-001')!.id;
 const [f]=await sql`INSERT INTO company_facts
   (tenant_id,kind,title,detail,keywords,valid_until,status,evidence_ref,verified_by,verified_at)
   VALUES(${tenant},'CERTIFICATION','Sertifikat ISO/IEC 27001:2022',
   'DefendIT360 memiliki sertifikat ISO/IEC 27001:2022 yang berlaku hingga Juni 2028.',
   ${['sertifikat','ISO','27001']},'2028-06-30','VERIFIED','Evidence-CERT-001',${creator},now())
   RETURNING id`;
 factId=f.id;
 await sql`INSERT INTO company_facts(tenant_id,kind,title,detail,keywords,valid_until,status,evidence_ref)
   VALUES(${tenant},'PERSONNEL','Personel GCIH lama',
     'Tim keamanan bersertifikat GCIH untuk VAPT','{GCIH}',current_date+3,'VERIFIED','CV lama'),
     (${tenant},'PERSONNEL','Personel GCIH belum valid',
       'Penyedia mempunyai 12 personel bersertifikat GCIH 2026','{GCIH}',null,'UNVERIFIED','Draft CV')`;
 const [{id:tenantB}]=await sql`INSERT INTO tenants(code,name)
   VALUES('P6B2B','Client Another Tenant') RETURNING id`;
 await sql`INSERT INTO users(tenant_id,email,full_name,role,password_hash,force_password_change)
   VALUES(${tenantB},'b2-admin@example.invalid','Tenant B Admin','company_admin',
      ${await bcrypt.hash(NEW_PW,12)},false)`;
 const other=await app.inject({method:'POST',url:'/api/v1/auth/login',
   payload:{tenant:'P6B2B',email:'b2-admin@example.invalid',password:NEW_PW}});
 if(other.statusCode!==200)throw Error(other.body);
 outside=api(app,other.json().token);
},60000);
afterAll(async()=>{
 if(app)await app.close();if(sql)await sql.end();
 if(oldPolicy===undefined)delete process.env.MFA_POLICY;else process.env.MFA_POLICY=oldPolicy;
 if(oldKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=oldKey;
});

describe('Phase6B2 verified-fact human-reviewed tender compliance',()=>{
 it('requires AI and tender write permission',async()=>{
  const r=await auditor.post(`/api/v1/tenders/${tenderId}/assistant/compliance-suggest`,{});
  expect(r.status).toBe(403);
 });
 it('uses only valid verified evidence and never modifies compliance without human decision',async()=>{
  q.push(JSON.stringify({items:[
    {ref:'QUAL-001',status:'COMPLY',facts:[1],
      quote:'memiliki sertifikat ISO/IEC 27001:2022 yang berlaku hingga Juni 2028',
      rationale:'Klaim didukung bukti yang masih berlaku'},
    {ref:'TECH-001',status:'COMPLY',facts:[9],
      quote:'Personel bersertifikat GCIH ada dua belas',rationale:'Hanya dugaan'},
    {ref:'COMM-001',status:'COMPLY',facts:[1],quote:'sertifikat ISO',
      rationale:'AI tidak boleh mengevaluasi harga'},
    {ref:'MADE-UP',status:'COMPLY',facts:[1],quote:'sertifikat ISO',
      rationale:'Nomor tidak ada'},
  ]}));
  const x=await maker.post(`/api/v1/tenders/${tenderId}/assistant/compliance-suggest`,{});
  expect(x.status).toBe(201);
  expect(x.body.created).toBe(2);
  expect(x.body.downgraded).toBe(1);
  expect(x.body.rejected).toBe(2);
  expect(prompts.join('')).not.toContain('Personel GCIH belum valid');
  expect(prompts.join('')).not.toContain('Personel GCIH lama');
  expect(prompts.join('')).not.toContain('COMM-001');
  const by=Object.fromEntries(x.body.suggestions.map((y:any)=>[y.refCode,y]));
  expect(by['QUAL-001']).toMatchObject({suggestedStatus:'COMPLY',verified:true,downgraded:false});
  expect(by['TECH-001']).toMatchObject({suggestedStatus:'CLARIFY',verified:false,downgraded:true});
  goodSuggestion=by['QUAL-001'].id;badSuggestion=by['TECH-001'].id;
  const [r]=await sql`SELECT compliance_status FROM tender_requirements WHERE id=${goodId}`;
  expect(r.complianceStatus).toBe('UNREVIEWED');
 });
 it('rejects maker approving their own proposal and blocks cross-tenant read/write',async()=>{
  expect((await maker.post(`/api/v1/tenders/${tenderId}/assistant/suggestions/${goodSuggestion}/decide`,
   {decision:'ACCEPT'})).status).toBe(403);
  expect((await outside.get(`/api/v1/tenders/${tenderId}/assistant/suggestions`)).status).toBe(404);
  expect((await outside.post(`/api/v1/tenders/${tenderId}/assistant/suggestions/${goodSuggestion}/decide`,
   {decision:'ACCEPT'})).status).toBe(404);
 });
 it('blocks a revoked VERIFIED fact on acceptance; checker then accepts once reverified',async()=>{
  await sql`UPDATE company_facts SET status='UNVERIFIED' WHERE id=${factId}`;
  expect((await checker.post(`/api/v1/tenders/${tenderId}/assistant/suggestions/${goodSuggestion}/decide`,
    {decision:'ACCEPT'})).status).toBe(409);
  await sql`UPDATE company_facts SET status='VERIFIED' WHERE id=${factId}`;
  const accepted=await checker.post(`/api/v1/tenders/${tenderId}/assistant/suggestions/${goodSuggestion}/decide`,
    {decision:'ACCEPT'});
  expect(accepted.status).toBe(200);
  expect(accepted.body.requirementStatus).toBe('COMPLY');
  expect((await checker.post(`/api/v1/tenders/${tenderId}/assistant/suggestions/${goodSuggestion}/decide`,
    {decision:'ACCEPT'})).status).toBe(409);
  const [r]=await sql`SELECT compliance_status,evidence,updated_by FROM tender_requirements WHERE id=${goodId}`;
  expect(r.complianceStatus).toBe('COMPLY');
  expect(r.evidence).toContain('Evidence-CERT-001');
 });
 it('can reject downgraded unsupported suggestions and retains unchanged requirement',async()=>{
  const rejected=await checker.post(`/api/v1/tenders/${tenderId}/assistant/suggestions/${badSuggestion}/decide`,
    {decision:'REJECT',note:'Bukti GCIH tidak diverifikasi'});
  expect(rejected.status).toBe(200);
  const [r]=await sql`SELECT compliance_status FROM tender_requirements WHERE id=${badId}`;
  expect(r.complianceStatus).toBe('UNREVIEWED');
  const listed=await checker.get(`/api/v1/tenders/${tenderId}/assistant/suggestions`);
  expect(listed.body.items).toHaveLength(0);
  const logs=await sql`SELECT action FROM audit_events WHERE entity_id=${tenderId}
    AND action LIKE 'tender.ai_suggestion_%'`;
  expect(logs.map(x=>x.action)).toEqual(expect.arrayContaining([
   'tender.ai_suggestion_accept','tender.ai_suggestion_reject',
  ]));
 });
});

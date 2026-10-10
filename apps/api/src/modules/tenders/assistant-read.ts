/**
 * ICOP Phase 6B1: Source-derived tender readiness and keyword evidence search.
 * No LLM verdict or auto-compliance. Vector retrieval and AI synthesis are
 * deliberately deferred to 6B2, so no pgvector migration is required.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requirePerm } from '../../lib/context.js';
import { notFound } from '../../lib/errors.js';
import { readiness } from './service.js';
import { tenderTerms, tenderTermScore, tenderExcerpt, rankTenderSources, type SourceExcerpt } from '../../lib/tender-grounding.js';

const wib=(value:unknown)=>value?new Date(String(value)).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',dateStyle:'medium',timeStyle:'short'})+' WIB':null;

export async function tenderAssistantReadRoutes(app:FastifyInstance) {
 const sql=app.sql,auth={onRequest:[app.authenticate]},R=requirePerm('tender.read');
 const params=z.object({id:z.string().uuid()});
 const load=async(tenantId:string,id:string)=>{
  const [t]=await sql`SELECT * FROM tenders WHERE id=${id} AND tenant_id=${tenantId}`;
  if(!t)throw notFound('Tender');return t;
 };

 app.get('/api/v1/tenders/:id/assistant/brief',{...auth,preValidation:R},async(req)=>{
  const {id}=params.parse(req.params),u=req.authUser;
  const t=await load(u.tenantId,id),now=Date.now();
  const due=t.submissionDeadline?new Date(String(t.submissionDeadline)).getTime():null;
  const reqs=await sql`SELECT ref_code,category,requirement,mandatory,compliance_status,risk_level,evidence
    FROM tender_requirements WHERE tender_id=${id} AND tenant_id=${u.tenantId} ORDER BY ref_code`;
  const [docs]=await sql`SELECT count(*)::int AS n,
     count(*) FILTER (WHERE extracted_text IS NOT NULL AND length(extracted_text)>0)::int AS text_ready
    FROM tender_documents WHERE tender_id=${id} AND tenant_id=${u.tenantId}`;
  const [clar]=await sql`SELECT count(*) FILTER(WHERE status='DRAFT')::int AS draft,
    count(*) FILTER(WHERE status='SUBMITTED')::int AS submitted,
    count(*) FILTER(WHERE status='ANSWERED')::int AS answered
    FROM tender_clarifications WHERE tender_id=${id} AND tenant_id=${u.tenantId}`;
  const horizon=new Date((due??now)+30*864e5).toISOString().slice(0,10);
  const facts=await sql`SELECT title,kind,valid_until FROM company_facts
    WHERE tenant_id=${u.tenantId} AND status='VERIFIED'
    AND valid_until IS NOT NULL AND valid_until<=${horizon}
    ORDER BY valid_until LIMIT 10`;
  const rd=await readiness(sql,id);
  const by=(status:string)=>reqs.filter(r=>r.complianceStatus===status).length;
  const mandatoryOpen=reqs.filter(r=>r.mandatory&&!['COMPLY','NOT_APPLICABLE'].includes(String(r.complianceStatus)));
  const days=due===null?null:Math.floor((due-now)/864e5);
  const actions:{priority:'HIGH'|'MEDIUM'|'LOW';text:string}[]=[];
  if(due!==null&&due<now)actions.push({priority:'HIGH',text:'Deadline submission telah lewat — periksa adendum resmi.'});
  if(!Number(docs.n))actions.push({priority:'HIGH',text:'Unggah dokumen RKS/KAK tender sebelum penilaian.'});
  else if(!Number(docs.textReady))actions.push({priority:'HIGH',text:'Dokumen belum memiliki teks — lakukan OCR/ekstraksi.'});
  if(Number(docs.n)>0&&!reqs.length)actions.push({priority:'HIGH',text:'Ekstrak dan validasi persyaratan RKS.'});
  if(by('UNREVIEWED'))actions.push({priority:'HIGH',text:`${by('UNREVIEWED')} persyaratan belum ditinjau.`});
  if(reqs.some(r=>r.mandatory&&r.complianceStatus==='NON_COMPLY'))
    actions.push({priority:'HIGH',text:'Ada persyaratan wajib NON-COMPLY — evaluasi risiko gugur dan Bid/No-Bid.'});
  if(by('CLARIFY')&&!Number(clar.draft)&&!Number(clar.submitted))
    actions.push({priority:'MEDIUM',text:'Siapkan pertanyaan aanwijzing/klarifikasi untuk persyaratan CLARIFY.'});
  if(Number(clar.draft))actions.push({priority:'MEDIUM',text:`${clar.draft} pertanyaan klarifikasi masih DRAFT.`});
  for(const f of facts)actions.push({priority:'MEDIUM',text:`Tinjau masa berlaku bukti ${f.title}: ${String(f.validUntil).slice(0,10)}.`});
  if(!rd.bidStatus&&['DISCOVERED','SCREENING','REGISTERED'].includes(String(t.status)))
    actions.push({priority:'MEDIUM',text:'Lakukan Bid/No-Bid sesuai Decision Authority.'});
  if(days!==null&&days>=0&&days<=3&&mandatoryOpen.length)
    actions.unshift({priority:'HIGH',text:`MENDESAK: ${days} hari menuju deadline, ${mandatoryOpen.length} persyaratan wajib terbuka.`});
  return {
    source:'DETERMINISTIC',requiresHumanReview:true,
    tender:{code:t.code,title:t.title,status:t.status},
    deadlines:{submissionDeadline:t.submissionDeadline,aanwijzingAt:t.aanwijzingAt,
      submissionWib:wib(t.submissionDeadline),daysToSubmission:days,passed:due!==null&&due<now},
    requirements:{total:reqs.length,mandatory:reqs.filter(r=>r.mandatory).length,
      byStatus:Object.fromEntries(['UNREVIEWED','COMPLY','PARTIAL','NON_COMPLY','CLARIFY','NOT_APPLICABLE'].map(x=>[x,by(x)])),
      mandatoryOpen:mandatoryOpen.slice(0,20).map(r=>({
        ref:r.refCode,category:r.category,requirement:String(r.requirement).slice(0,220),
        status:r.complianceStatus,risk:r.riskLevel})),
      highRiskOpen:reqs.filter(r=>r.riskLevel==='HIGH'&&!['COMPLY','NOT_APPLICABLE'].includes(r.complianceStatus)).length},
    documents:docs,clarifications:clar,expiringEvidence:facts,
    readiness:{percent:rd.percent,blockers:rd.blockers},actions,
  };
 });

 app.post('/api/v1/tenders/:id/assistant/search',{...auth,preValidation:R,
   config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(req)=>{
  const {id}=params.parse(req.params);
  const {question}=z.object({question:z.string().trim().min(5).max(1000)}).parse(req.body);
  const u=req.authUser,t=await load(u.tenantId,id),terms=tenderTerms(question);
  if(!terms.length)return {grounded:false,mode:'keyword',answer:null,sources:[],
    message:'Tidak ada kata kunci spesifik; jelaskan topik atau nama persyaratan.'};
  const link=`/tenders/${id}`,hits:SourceExcerpt[]=[];
  const push=(kind:SourceExcerpt['kind'],title:string,ref:string,text:string,sourceId:string|null)=>{
    const score=tenderTermScore(text,terms);
    if(score>0)hits.push({id:`${kind}-${hits.length+1}`,kind,title,ref,
      excerpt:tenderExcerpt(text,terms,500),score,sourceId});
  };
  const meta=[`Kode tender: ${t.code}`,`Judul: ${t.title}`,`Pemberi kerja: ${t.procuringEntity}`,
    t.procurementMethod&&`Metode: ${t.procurementMethod}`,
    t.submissionDeadline&&`Deadline submission: ${wib(t.submissionDeadline)}`,
    t.aanwijzingAt&&`Jadwal aanwijzing: ${wib(t.aanwijzingAt)}`].filter(Boolean).join('\n');
  push('TENDER',String(t.title),'data tender',meta,id);
  const docs=await sql`SELECT id,filename,extracted_text FROM tender_documents
    WHERE tender_id=${id} AND tenant_id=${u.tenantId} AND extracted_text IS NOT NULL`;
  for(const d of docs){
    const pages=String(d.extractedText).split(/\f|\n(?=\s*(?:HALAMAN|PAGE)\s+\d+)/i).slice(0,300);
    for(let n=0;n<pages.length;n++){
      for(let j=0;j<pages[n].length;j+=1800){
        const snippet=pages[n].slice(j,j+2000);
        push('RKS',String(d.filename),pages.length>1?`hal. ${n+1}`:'teks dokumen',snippet,String(d.id));
      }
    }
  }
  const reqs=await sql`SELECT id,ref_code,category,requirement,mandatory FROM tender_requirements
    WHERE tender_id=${id} AND tenant_id=${u.tenantId}`;
  for(const r of reqs)push('REQUIREMENT',`Persyaratan ${r.refCode} (${r.category})`,
    String(r.refCode),String(r.requirement),String(r.id));
  const clar=await sql`SELECT id,question,answer FROM tender_clarifications
    WHERE tender_id=${id} AND tenant_id=${u.tenantId} AND status='ANSWERED' AND answer IS NOT NULL`;
  for(const c of clar){
    push('AANWIJZING','Klarifikasi panitia','jawaban aanwijzing',
      `Pertanyaan: ${c.question}\nJawaban resmi: ${c.answer}`,String(c.id));
  }
  const matches=rankTenderSources(hits,8).map((x,i)=>({...x,n:i+1,link}));
  await audit(sql,u,'tender.assistant_keyword_search','tender',id,null,
    {terms:terms.length,sources:matches.length},req.ip);
  return {grounded:matches.length>0,mode:'keyword',answer:null,
    message:matches.length?'Cuplikan dokumen ditemukan. Tinjau sumber; belum ada kesimpulan AI.':
      'Tidak ditemukan pada data tender, RKS, persyaratan, atau aanwijzing yang tersedia.',
    sources:matches,requiresHumanReview:true,
    disclaimer:'Hasil pencarian hanya menunjukkan potongan sumber; tidak membuktikan kepatuhan atau menggantikan RKS/adendum resmi.'};
 });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStagingQuotation } from './staging-quotation.mjs';

const base='https://icop-staging-api.elang-haqeem.workers.dev';
const me={id:'verified-owner-id',email:'elang.haqeem@gmail.com',role:'super_admin',
  permissions:['quotation.read','quotation.write']};
const session=async()=>me;
const req=(path,init)=>new Request(base+path,init);
const good=()=>({
  submissionKey:'20261017-QT-01',
  customerName:'PT Pelanggan Sumber Asli',
  customerEmail:'buyer@example.org',
  opportunityRef:'OPP-2026-101',
  serviceCategory:'Cybersecurity Governance',
  title:'Assessment Governance Security',
  scopeSummary:'Review kebijakan dan dokumentasi',
  lines:[{description:'GAP Analysis',quantity:2,unit:'hari',unitPrice:1250000},
    {description:'Risk workshop',quantity:1,unit:'paket',unitPrice:500000}],
  discountPercent:10,taxPercent:11,validityDays:30,
  paymentTerms:'Dibayarkan setelah BAST',
  deliveryTerms:'Dilaksanakan secara remote',
  exclusions:'Biaya perjalanan tidak termasuk'
});
function store(){
  const state={rows:[],audits:[],tenant:{id:'DEIT-tenant'}};
  const DB={
    prepare(sql){
      let args=[];
      return {
        bind(...v){args=v;return this;},
        async first(){
          if(sql.includes("FROM tenants WHERE code='DEIT'"))return state.tenant;
          if(sql.includes('SELECT * FROM staging_quotation_drafts'))return state.rows.find(x=>x.id===args[0]&&x.tenant_id===args[1])||null;
          if(sql.includes('FROM staging_quotation_drafts WHERE tenant_id=? AND owner_user_id=?'))return state.rows.find(x=>x.tenant_id===args[0]&&x.owner_user_id===args[1]&&x.submission_key===args[2])||null;
          throw Error('Unknown SELECT first: '+sql);
        },
        async all(){
          if(sql.includes('FROM staging_quotation_drafts WHERE tenant_id=? ORDER BY'))
            return {results:state.rows.filter(x=>x.tenant_id===args[0]).slice(0,100)};
          throw Error('Unknown SELECT all: '+sql);
        },
        async run(){
          if(sql.startsWith('INSERT OR IGNORE INTO staging_quotation_drafts')){
            const [id,tenant_id,owner_user_id,submission_key,customer_name,customer_email,
              opportunity_ref,service_category,title,scope_summary,lines_json,
              discount_percent,tax_percent,subtotal,discount_amount,taxable_amount,
              tax_amount,grand_total,validity_days,payment_terms,delivery_terms,exclusions]=args;
            if(state.rows.some(x=>x.tenant_id===tenant_id&&x.owner_user_id===owner_user_id&&x.submission_key===submission_key))
              return {meta:{changes:0}};
            state.rows.push({id,tenant_id,owner_user_id,submission_key,customer_name,customer_email,
              opportunity_ref,service_category,title,scope_summary,lines_json,
              discount_percent,tax_percent,subtotal,discount_amount,taxable_amount,
              tax_amount,grand_total,validity_days,payment_terms,delivery_terms,exclusions,
              status:'DRAFT',source:'MANUAL_UNVERIFIED',created_at:'2026-10-17 10:00:00'});
            return {meta:{changes:1}};
          }
          if(sql.startsWith('INSERT INTO audit_events')){
            if(state.failAudit)throw Error('injected-audit-failure');
            if(state.rows.some(x=>x.id===args[4]&&x.tenant_id===args[5])){
              state.audits.push({tenant:args[0],owner:args[1],entity:args[2],after:args[3]});
              return {meta:{changes:1}};
            }
            return {meta:{changes:0}};
          }
          throw Error('Unknown run: '+sql);
        }
      };
    },
    async batch(queries){
      const beforeRows=structuredClone(state.rows),beforeAudits=structuredClone(state.audits);
      try{
        const results=[];
        for(const q of queries) results.push(await q.run());
        return results;
      }catch(e){
        state.rows=beforeRows;state.audits=beforeAudits;
        throw e;
      }
    }
  };
  return {DB,state,SESSION_HMAC_KEY:'f'.repeat(64)};
}
const post=(data,headers={})=>req('/api/v1/quotation-drafts',{
  method:'POST',headers:{'content-type':'application/json',origin:base,...headers},
  body:JSON.stringify(data)
});
async function signedPost(env,data,headers={}) {
  const r=await handleStagingQuotation(req('/quotations/new'),env,session);
  assert.equal(r.status,200);
  const html=await r.text();
  const token=html.match(/name="csrfToken" value="([^"]+)"/)?.[1];
  assert.match(token,/^v1\.[0-9]{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/);
  return post({...data,csrfToken:token},headers);
}
test('Quotation menu and direct new form are available on mobile with no fabricated records',async()=>{
  const env=store();
  const list=await handleStagingQuotation(req('/quotations'),env,session);
  assert.equal(list.status,200);
  const listBody=await list.text();
  assert.match(listBody,/Buat Quotation/);
  assert.match(listBody,/Belum ada draft quotation/);
  assert.doesNotMatch(listBody,/PT Nusantara Digital Services/);
  const form=await handleStagingQuotation(req('/quotations/new'),env,session);
  assert.equal(form.status,200);
  const html=await form.text();
  assert.match(html,/Form Quotation/);
  assert.match(html,/name="viewport"/);
  assert.match(html,/@media\(max-width:680px\)/);
  assert.match(html,/name="customerName"/);
  assert.match(html,/name="taxPercent"/);
  assert.match(html,/\/__icop\/quotation.js/);
  assert.match(html,/Status otomatis/);
  const js=await handleStagingQuotation(req('/__icop/quotation.js'),env,session);
  assert.equal(js.status,200);
  assert.match(await js.text(),/credentials:'same-origin'/);
});
test('A verified admin saves real DRAFT to tenant D1, server computes totals and creates audit atomically',async()=>{
  const env=store();
  const response=await handleStagingQuotation(await signedPost(env,good()),env,session);
  assert.equal(response.status,201,await response.clone().text());
  const body=await response.json();
  assert.equal(body.status,'DRAFT');
  assert.equal(body.grandTotal,2997000);
  assert.equal(env.state.rows.length,1);
  const saved=env.state.rows[0];
  assert.equal(saved.subtotal,3000000);
  assert.equal(saved.discount_amount,300000);
  assert.equal(saved.taxable_amount,2700000);
  assert.equal(saved.tax_amount,297000);
  assert.equal(saved.source,'MANUAL_UNVERIFIED');
  assert.equal(saved.tenant_id,'DEIT-tenant');
  assert.equal(saved.owner_user_id,'verified-owner-id');
  assert.equal(env.state.audits.length,1);
  assert.equal(env.state.audits[0].owner,'verified-owner-id');
  const detail=await handleStagingQuotation(req('/quotations/'+body.id),env,session);
  assert.equal(detail.status,200);
  assert.match(await detail.text(),/GAP Analysis/);
});
test('Submission retry does not duplicate draft or audit',async()=>{
  const env=store(),data=good();
  assert.equal((await handleStagingQuotation(await signedPost(env,data),env,session)).status,201);
  const again=await handleStagingQuotation(await signedPost(env,data),env,session);
  assert.equal(again.status,200);
  assert.equal(env.state.rows.length,1);
  assert.equal(env.state.audits.length,1);
});
test('CSRF, MFA session and permissions reject unauthorized draft creation',async()=>{
  const env=store();
  const cross=await handleStagingQuotation(await signedPost(env,good(),{origin:'https://evil.example'}),env,session);
  assert.equal(cross.status,403);
  const unauth=await handleStagingQuotation(await signedPost(env,good()),env,async()=>null);
  assert.equal(unauth.status,401);
  const noWrite=await handleStagingQuotation(await signedPost(env,good()),env,async()=>({...me,permissions:['quotation.read']}));
  assert.equal(noWrite.status,403);
  assert.equal(env.state.rows.length,0);
});
test('Invalid totals, missing customer and malformed lines fail without inserts',async()=>{
  const env=store(),cases=[
    {...good(),customerName:''},
    {...good(),taxPercent:34},
    {...good(),lines:[{description:'x',quantity:-2,unit:'hari',unitPrice:50}]},
    {...good(),lines:[{description:'ok',quantity:1,unit:'hari',unitPrice:-1}]},
    {...good(),discountPercent:100},
    {...good(),submissionKey:'bad'},
    {...good(),taxPercent:11.001}
  ];
  for(const x of cases){
    const response=await handleStagingQuotation(await signedPost(env,x),env,session);
    assert.equal(response.status,422,await response.clone().text());
  }
  assert.equal(env.state.rows.length,0);
});
test('Audit insertion failure rolls back draft row',async()=>{
  const env=store();env.state.failAudit=true;
  const r=await handleStagingQuotation(await signedPost(env,good()),env,session);
  assert.equal(r.status,503);
  assert.deepEqual(env.state.rows,[]);
  assert.deepEqual(env.state.audits,[]);
});
test('Tenant-scoped detail not leaked to another tenant and user text escaped',async()=>{
  const env=store(),data=good();data.title='<img src=x onerror=alert(1)>';
  const created=await handleStagingQuotation(await signedPost(env,data),env,session);
  assert.equal(created.status,201);
  const id=(await created.json()).id;
  const page=await handleStagingQuotation(req('/quotations/'+id),env,session);
  const html=await page.text();
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img src=x'));
  env.state.tenant.id='DIFFERENT_TENANT';
  const other=await handleStagingQuotation(req('/quotations/'+id),env,session);
  assert.equal(other.status,404);
});

test('Android Origin null and Origin-less requests accept only a signed session-bound form token',async()=>{
  const env=store();
  const data=good();
  const android=await handleStagingQuotation(await signedPost(env,data,{origin:'null','sec-fetch-site':'same-origin'}),env,session);
  assert.equal(android.status,201);
  const form=await handleStagingQuotation(req('/quotations/new'),env,session);
  const token=(await form.text()).match(/name="csrfToken" value="([^"]+)"/)?.[1];
  const clean=new Request(base+'/api/v1/quotation-drafts',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({...good(),submissionKey:'mobile-without-origin',csrfToken:token})
  });
  const accepted=await handleStagingQuotation(clean,env,session);
  assert.equal(accepted.status,201);
  const missing=await handleStagingQuotation(post({...good(),submissionKey:'token-missing'}),env,session);
  assert.equal(missing.status,403);
  const forged=await handleStagingQuotation(post({...good(),submissionKey:'token-forged',csrfToken:'v1.1000000000.'+'0'.repeat(32)+'.'+'1'.repeat(64)}),env,session);
  assert.equal(forged.status,403);
  assert.equal(env.state.rows.length,2);
});

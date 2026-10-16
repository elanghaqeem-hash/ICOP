import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker from '../src/worker.mjs';
import {hashNewPassword} from '../src/security/credentials.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;

const ORIGIN='https://icop-staging-api.example.invalid';
const ROUTE=ORIGIN+'/api/v1/auth/initial-password-change';
const OLD='Current#Staging-2026-Password';
const NEW='Changed#Staging-2026-Password';
const hash=await hashNewPassword(OLD);
const flags={
  AUTH_V2_ENABLED:'true',ACCESS_IDENTITY_ENABLED:'true',
  ACCESS_MFA_CONFIRMED:'true',PASSWORD_FIRST_FACTOR_ENABLED:'true',
  PASSWORD_CHANGE_ENABLED:'true',ACCESS_AUD:'staging-aud',
  ACCESS_AUDIT_HMAC_KEY:'a1'.repeat(32)
};
const ctx={access:{aud:'staging-aud',
  getIdentity:async()=>({email:'operator@example.invalid'})}};
function req(path=ROUTE,{
  origin=ORIGIN,fetchSite='same-origin',type='application/json',
  body={tenantCode:'DEIT',currentPassword:OLD,newPassword:NEW},
  method='POST',length
}={}){
  const headers={'origin':origin,'sec-fetch-site':fetchSite,'content-type':type,
    'cf-connecting-ip':'192.0.2.44'};
  if(length!==undefined)headers['content-length']=String(length);
  return new Request(path,{method,headers,body:JSON.stringify(body)});
}
function fakeDb(){
  const queries=[],batches=[];
  const user={id:'staff-id',tenant_id:'tenant-deit',
    email_normalized:'operator@example.invalid',password_hash:hash,
    role:'company_admin',is_active:1,force_password_change:1,
    mfa_enabled:0,failed_logins:0,locked_until:null,token_version:2};
  return {queries,batches,prepare(sql){return{bind(...args){
    queries.push({sql,args});
    return {sql,args,first:async()=>user,run:async()=>({success:true})};
  }}},batch:async statements=>{
    batches.push(statements.length);
    return statements.map(()=>({success:true,meta:{changes:1}}));
  }};
}
async function call(request,env={},access=ctx){
  const response=await worker.fetch(request,env,access);
  return {status:response.status,headers:response.headers,body:await response.json()};
}
test('initial password-change endpoint is 503 with default staging flags; no DB traffic',async()=>{
  const DB=fakeDb();
  const result=await call(req(),{...flags,PASSWORD_CHANGE_ENABLED:undefined,DB});
  assert.equal(result.status,503);
  assert.equal(result.body.code,'STAGING_AUTH_NOT_READY');
  assert.equal(DB.queries.length,0);
  assert.equal(DB.batches.length,0);
  assert.equal(result.headers.get('cache-control'),'no-store');
});
test('a same-origin barrier blocks CSRF before any password processing',async()=>{
  const DB=fakeDb();
  for(const request of [
    req(ROUTE,{origin:'https://attacker.invalid'}),
    req(ROUTE,{origin:ORIGIN,fetchSite:'cross-site'})
  ]){
    const result=await call(request,{...flags,DB});
    assert.equal(result.status,403);
    assert.equal(result.body.code,'ORIGIN_DENIED');
  }
  assert.equal(DB.queries.length,0);
});
test('Access signature/identity, MIME and request size are required',async()=>{
  const DB=fakeDb();
  const unauth=await call(req(),{...flags,DB},{});
  assert.equal(unauth.status,403);
  assert.equal(unauth.body.code,'ACCESS_REQUIRED');
  const mime=await call(req(ROUTE,{type:'text/plain'}),{...flags,DB});
  assert.equal(mime.status,415);
  const big=await call(req(ROUTE,{length:5000}),{...flags,DB});
  assert.equal(big.status,413);
  assert.equal(DB.queries.length,0);
});
test('invalid JSON and missing first-factor fields do not change DB',async()=>{
  const DB=fakeDb();
  const invalid=await call(new Request(ROUTE,{method:'POST',
    headers:{origin:ORIGIN,'content-type':'application/json'},
    body:'{not-json'}),{...flags,DB});
  assert.equal(invalid.status,400);
  const missing=await call(req(ROUTE,{body:{tenantCode:'DEIT',password:'wrong'}}),
    {...flags,DB});
  assert.equal(missing.status,400);
  assert.equal(DB.queries.length,0);
});
test('synthetic approved first-login change returns 202, no bearer/cookie or app login',async()=>{
  const DB=fakeDb();
  const result=await call(req(),{...flags,DB});
  assert.equal(result.status,202);
  assert.deepEqual(result.body,{
    status:'password_changed_mfa_enrollment_pending',
    applicationAuthenticated:false,
    mfaEnrollmentRequired:true,sessionIssued:false
  });
  assert.equal(result.headers.get('set-cookie'),null);
  const all=JSON.stringify(DB.queries);
  assert.ok(!all.includes(OLD));
  assert.ok(!all.includes(NEW));
  assert.ok(!all.includes('192.0.2.44'));
  assert.deepEqual(DB.batches,[2,3]);
  assert.equal((await call(new Request(ORIGIN+'/api/v1/auth/login',{
    method:'POST'}),{...flags,DB})).status,503);
});

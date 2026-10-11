import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../src/worker.mjs';
import { hashSessionToken } from '../src/security/session.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const key='ab'.repeat(32);
const token='s1_'+'cd'.repeat(32);
const ORIGIN='https://icop-staging-api.example.invalid';
const now=Math.floor(Date.now()/1000);
const session={tenant_id:'tenant-deit',user_id:'user-a',session_version:3,user_version:3,
 mfa_verified:1,issued_at:now-10,expires_at:now+600,revoked_at:null,
 role:'auditor',is_active:1,force_password_change:0,mfa_enabled:1};
const ctx=(email='verified@example.invalid')=>({access:{
 aud:'synthetic-aud',getIdentity:async()=>({email})}});
function mockDb({sessionRow=session,userEmail='verified@example.invalid'}={}) {
 const log=[];
 return {log,prepare(sql){return {bind(...args){log.push({sql,args});return {async first(){
   if(sql.includes('FROM auth_sessions s'))return sessionRow;
   if(sql.includes('SELECT email_normalized FROM users'))return userEmail?{email_normalized:userEmail}:null;
   if(sql.includes('migration_history'))return {version:args[0]};
   return null;
 },async run(){return {success:true}}};}};}};
}
const request=(tenant='tenant-deit',theToken=token)=>new Request(ORIGIN+'/api/v1/auth/me',{
 headers:{'x-icop-tenant':tenant,cookie:theToken?'__Host-icop-staging-session='+theToken:''}});
const flags={AUTH_V2_ENABLED:'true',ACCESS_IDENTITY_ENABLED:'true',
 ACCESS_MFA_CONFIRMED:'true',ACCESS_AUD:'synthetic-aud',
 SESSION_HMAC_KEY:key};
async function api(r,e,c){const x=await worker.fetch(r,e,c);return {code:x.status,data:await x.json()};}

test('default-deny even with forged token and synthetic D1 subject',async()=>{
 const DB=mockDb();
 const response=await api(request(),{DB,...flags,AUTH_V2_ENABLED:undefined},ctx());
 assert.equal(response.code,503);
 assert.equal(response.data.code,'STAGING_AUTH_NOT_READY');
 assert.equal(DB.log.length,0);
});
test('Access is mandatory before D1 session lookup',async()=>{
 const DB=mockDb();
 const x=await api(request(),{DB,...flags},undefined);
 assert.equal(x.code,403);
 assert.equal(x.data.code,'ACCESS_REQUIRED');
 assert.equal(DB.log.length,0);
});
test('valid D1 session + matching Access identity returns minimal scoped principal',async()=>{
 const DB=mockDb();
 const x=await api(request(),{DB,...flags},ctx());
 assert.equal(x.code,200);
 assert.deepEqual(x.data,{user:{id:'user-a',tenantId:'tenant-deit',role:'auditor'},
   mfaVerified:true,applicationAuthenticated:true});
 assert.equal('token' in x.data,false);
 assert.ok(DB.log.some(q=>q.sql.includes('FROM auth_sessions s')));
 assert.ok(!JSON.stringify(x).includes(key));
});
test('cross-tenant, expired, inactive, MFA-missing and forged principal are rejected',async()=>{
 const invalid=[
   [request('other-tenant'),session,'verified@example.invalid'],
   [request(),{...session,expires_at:now-10},'verified@example.invalid'],
   [request(),{...session,mfa_verified:0},'verified@example.invalid'],
   [request(),{...session,is_active:0},'verified@example.invalid'],
   [request(),session,'other@example.invalid'],
 ];
 for(const [req,row,email] of invalid){
   const x=await api(req,{...flags,DB:mockDb({sessionRow:row,userEmail:email})},ctx());
   assert.ok(x.code===401||x.code===403);
   assert.equal(x.data.applicationAuthenticated,undefined);
 }
 const invalidToken=await api(request('tenant-deit','forged'),
   {...flags,DB:mockDb()},ctx());
 assert.equal(invalidToken.code,401);
});
test('tenant header, secret and identity provider must be valid',async()=>{
 const DB=mockDb();
 assert.equal((await api(request('../escape'),{...flags,DB},ctx())).code,400);
 assert.equal((await api(request(),{...flags,DB,SESSION_HMAC_KEY:'weak'},ctx())).code,401);
 const spoof=await api(new Request(ORIGIN+'/api/v1/auth/me',{
  headers:{'x-icop-tenant':'tenant-deit','x-user-role':'super_admin',
   'cf-access-jwt-assertion':'fake',cookie:'__Host-icop-staging-session='+token}}),
  {...flags,DB},undefined);
 assert.equal(spoof.code,403);
 assert.match(await hashSessionToken(token,key),/^[a-f0-9]{64}$/);
});

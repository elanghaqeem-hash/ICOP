import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { hashNewPassword } from '../src/security/credentials.mjs';
import { verifyStagingFirstFactor } from '../src/security/first-factor.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const ip='192.0.2.10', password='Strong#StagingPassword2026!', now=1800000000000;
const flags={AUTH_V2_ENABLED:'true',ACCESS_IDENTITY_ENABLED:'true',
  ACCESS_MFA_CONFIRMED:'true',PASSWORD_FIRST_FACTOR_ENABLED:'true',
  ACCESS_AUD:'synthetic-aud',ACCESS_AUDIT_HMAC_KEY:'aa'.repeat(32)};
const ctx={access:{aud:'synthetic-aud',getIdentity:async()=>({email:'STAFF@example.invalid'})}};
const locked={id:'user-test',tenant_id:'tenant-deit',email_normalized:'staff@example.invalid',
  role:'company_admin',is_active:1,force_password_change:0,
  mfa_enabled:1,failed_logins:0,locked_until:null,token_version:2};
const hash=await hashNewPassword(password);
function fakeD1(user={...locked,password_hash:hash},failBatch=false) {
  const calls=[];
  return {calls,prepare(sql) {
    return {bind(...values) {
      calls.push({sql,values});
      return {first:async()=>user,run:async()=>({success:true,meta:{changes:1}})};
    }};
  },batch:async statements=>{
    calls.push({batch:statements.length});
    if(failBatch) throw Error('simulated D1 fault');
    return statements.map(()=>({success:true,meta:{changes:1}}));
  }};
}
const args=db=>({db,ctx,tenantCode:'DEIT',password,env:flags,ip,now});
test('U01/U24: authorized password verifies identity but NEVER issues a session',async()=>{
  const db=fakeD1();
  const result=await verifyStagingFirstFactor(args(db));
  assert.deepEqual(result,{ok:true,tenantId:'tenant-deit',userId:'user-test',
    mfaRequired:true,sessionIssued:false});
  const log=JSON.stringify(db.calls);
  assert.equal(log.includes(password),false);
  assert.equal(log.includes(hash),false);
  assert.equal(log.includes(ip),false);
  assert.ok(log.includes('hmac-sha256:'));
  assert.ok(log.includes('auth.password_verified_mfa_pending'));
  assert.ok(!log.includes('INSERT INTO auth_sessions'));
});
test('U01: no Access or release flags can never inspect D1 accounts',async()=>{
  const db=fakeD1();
  assert.equal((await verifyStagingFirstFactor({...args(db),
    env:{...flags,AUTH_V2_ENABLED:'false'}})).code,'STAGING_AUTH_NOT_READY');
  assert.equal((await verifyStagingFirstFactor({...args(db),
    ctx:{access:{aud:'forged-aud',getIdentity:async()=>({email:'staff@example.invalid'})}}})).code,'ACCESS_REQUIRED');
  assert.equal((await verifyStagingFirstFactor({...args(db),ctx:{}})).code,'ACCESS_REQUIRED');
  assert.equal(db.calls.length,0);
});
test('U01/U24: wrong password fails, locks and records pseudonymous audit',async()=>{
  const db=fakeD1();
  const result=await verifyStagingFirstFactor({...args(db),password:'Invalid#Pass12345'});
  assert.equal(result.ok,false);
  assert.equal(result.code,'INVALID_CREDENTIALS');
  const log=JSON.stringify(db.calls);
  assert.ok(log.includes('auth.login_failed'));
  assert.ok(log.includes('failed_logins=failed_logins+1'));
  assert.equal(log.includes('Invalid#Pass12345'),false);
  assert.equal(log.includes(ip),false);
  const failure=await verifyStagingFirstFactor({...args(fakeD1({...locked,password_hash:hash},true)),password:'Invalid#Pass12345'});
  assert.equal(failure.code,'STAGING_DB_NOT_READY');
});
test('lockout / inactive user / tenant mismatch deny without session',async()=>{
  const lockDb=fakeD1({...locked,password_hash:hash,locked_until:'2027-01-16 00:00:00'});
  assert.equal((await verifyStagingFirstFactor(args(lockDb))).code,'ACCOUNT_LOCKED');
  const inactive=fakeD1({...locked,password_hash:hash,is_active:0});
  assert.equal((await verifyStagingFirstFactor(args(inactive))).code,'INVALID_CREDENTIALS');
  const noMembership=fakeD1(null);
  assert.equal((await verifyStagingFirstFactor(args(noMembership))).code,'INVALID_CREDENTIALS');
  assert.equal((await verifyStagingFirstFactor({...args(fakeD1()),tenantCode:'bad/tenant'})).code,'AUTH_INVALID');
});
test('U01: password accepted without enrollment or change requirement does not create a session',async()=>{
  const change=fakeD1({...locked,password_hash:hash,force_password_change:1});
  assert.equal((await verifyStagingFirstFactor(args(change))).code,'PASSWORD_CHANGE_REQUIRED');
  const enroll=fakeD1({...locked,password_hash:hash,mfa_enabled:0});
  assert.equal((await verifyStagingFirstFactor(args(enroll))).code,'MFA_ENROLLMENT_REQUIRED');
  assert.equal(change.calls.some(x=>x.batch),false);
  assert.equal(enroll.calls.some(x=>x.batch),false);
});

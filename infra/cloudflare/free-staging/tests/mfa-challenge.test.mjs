import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {hashNewPassword} from '../src/security/credentials.mjs';
import {issueMfaChallenge,resolveMfaChallenge} from '../src/security/mfa-challenge.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const password='Realistic#StagingPass2026';
const passwordHash=await hashNewPassword(password);
const now=1800000000;
const env={
  ACCESS_AUD:'synthetic-worker-access-aud',
  AUTH_V2_ENABLED:'true',ACCESS_IDENTITY_ENABLED:'true',
  ACCESS_MFA_CONFIRMED:'true',PASSWORD_FIRST_FACTOR_ENABLED:'true',
  MFA_CHALLENGE_ENABLED:'true',
  ACCESS_AUDIT_HMAC_KEY:'ab'.repeat(32),
  AUTH_CHALLENGE_HMAC_KEY:'cd'.repeat(32)
};
const original={
  id:'u-one',tenant_id:'tenant-one',email_normalized:'staff@example.invalid',
  password_hash:passwordHash,role:'company_admin',is_active:1,
  force_password_change:0,mfa_enabled:0,failed_logins:0,
  locked_until:null,token_version:2
};
const ctx=(email='staff@example.invalid')=>({
  access:{aud:env.ACCESS_AUD,getIdentity:async()=>({email})}
});
function fakeDb({user={...original},challengeRow=null,
  failChallenge=false}={}){
  const calls=[],batches=[];
  let stored=challengeRow;
  return {
    calls,batches,
    prepare(sql){
      return {bind(...args){
        const prepared={sql,args,
          first:async()=>{
            if(sql.includes('FROM auth_mfa_challenges'))return stored;
            if(sql.includes('FROM users u INNER JOIN tenants'))return user;
            return null;
          }};
        calls.push(prepared);
        return prepared;
      }};
    },
    async batch(commands){
      batches.push(commands.map(x=>({sql:x.sql,args:x.args})));
      if(failChallenge&&commands.some(x=>x.sql.includes('INSERT INTO auth_mfa_challenges')))
        return [{success:true,meta:{changes:0}},{success:true,meta:{changes:0}}];
      for(const c of commands)if(c.sql.includes('INSERT INTO auth_mfa_challenges')){
        const a=c.args;
        stored={challenge_hash:a[0],tenant_id:user.tenant_id,user_id:user.id,
          purpose:a[1],identity_hash:a[2],issued_at:a[3],expires_at:a[4],
          token_version:user.token_version,consumed_at:null};
      }
      return commands.map(()=>({success:true,meta:{changes:1}}));
    },
    getStored:()=>stored
  };
}
const args=db=>({
  ctx:ctx(),db,env,tenantCode:'DEIT',password,ip:'192.0.2.42',now
});
test('issue enrollment challenge only after Access-bound password; no session',async()=>{
  const db=fakeDb();
  const result=await issueMfaChallenge(args(db));
  assert.equal(result.ok,true);
  assert.equal(result.purpose,'mfa_enroll');
  assert.match(result.challenge,/^m1_[a-f0-9]{64}$/);
  assert.equal(result.expiresAt,now+300);
  assert.equal(result.sessionIssued,false);
  assert.equal(result.applicationAuthenticated,false);
  assert.equal(db.getStored().challenge_hash.length,64);
  assert.notEqual(db.getStored().challenge_hash,result.challenge);
  assert.deepEqual(db.batches.map(batch=>batch.length),[2,2]);
  const dbLog=JSON.stringify(db.calls);
  assert.equal(dbLog.includes(password),false);
  assert.equal(dbLog.includes('192.0.2.42'),false);
  assert.equal(dbLog.includes('INSERT INTO auth_sessions'),false);
  const checked=await resolveMfaChallenge({ctx:ctx(),db,env,
    tenantCode:'DEIT',challenge:result.challenge,purpose:'mfa_enroll',now:now+10});
  assert.equal(checked.ok,true);
  assert.equal(checked.tenantId,'tenant-one');
  assert.equal(checked.tokenVersion,2);
  assert.equal('challenge' in checked,false);
});
test('enrolled user receives login challenge, never an authenticated session',async()=>{
  const db=fakeDb({user:{...original,mfa_enabled:1}});
  const issued=await issueMfaChallenge(args(db));
  assert.equal(issued.purpose,'mfa_login');
  const result=await resolveMfaChallenge({ctx:ctx(),db,env,
    tenantCode:'DEIT',challenge:issued.challenge,purpose:'mfa_login',now});
  assert.equal(result.ok,true);
  const wrongPurpose=await resolveMfaChallenge({ctx:ctx(),db,env,
    tenantCode:'DEIT',challenge:issued.challenge,purpose:'mfa_enroll',now});
  assert.equal(wrongPurpose.code,'AUTH_CHALLENGE_INVALID');
});
test('default-off flags and forged Access deny before D1',async()=>{
  const db=fakeDb();
  assert.equal((await issueMfaChallenge({...args(db),
    env:{...env,MFA_CHALLENGE_ENABLED:undefined}})).code,'STAGING_AUTH_NOT_READY');
  assert.equal((await issueMfaChallenge({...args(db),
    ctx:{access:{aud:'forged',getIdentity:ctx().access.getIdentity}}})).code,
    'ACCESS_REQUIRED');
  assert.equal((await resolveMfaChallenge({ctx:ctx(),db,env:{
    ...env,AUTH_V2_ENABLED:undefined},tenantCode:'DEIT',challenge:'m1_'+'a'.repeat(64),
    purpose:'mfa_enroll',now})).code,'STAGING_AUTH_NOT_READY');
  assert.equal(db.calls.length,0);
});
test('password-change-required, invalid password and disabled member cannot issue',async()=>{
  const first=fakeDb({user:{...original,force_password_change:1}});
  assert.equal((await issueMfaChallenge(args(first))).code,'PASSWORD_CHANGE_REQUIRED');
  const wrong=fakeDb();
  assert.equal((await issueMfaChallenge({...args(wrong),password:'wrong'})).code,
    'INVALID_CREDENTIALS');
  const inactive=fakeDb({user:{...original,is_active:0}});
  assert.equal((await issueMfaChallenge(args(inactive))).code,'INVALID_CREDENTIALS');
  assert.ok(!JSON.stringify(wrong.calls).includes('INSERT INTO auth_mfa_challenges'));
});
test('expiry, consumed state, changed principal and token rotation deny',async()=>{
  const db=fakeDb();
  const issued=await issueMfaChallenge(args(db));
  const base={ctx:ctx(),db,env,tenantCode:'DEIT',
    challenge:issued.challenge,purpose:'mfa_enroll',now:now+1};
  assert.equal((await resolveMfaChallenge({...base,now:now+300})).code,
    'AUTH_CHALLENGE_INVALID');
  assert.equal((await resolveMfaChallenge({...base,ctx:ctx('other@example.invalid')})).code,
    'AUTH_CHALLENGE_INVALID');
  db.getStored().consumed_at=now+1;
  assert.equal((await resolveMfaChallenge(base)).code,'AUTH_CHALLENGE_INVALID');
  db.getStored().consumed_at=null;
  db.getStored().token_version=1;
  assert.equal((await resolveMfaChallenge(base)).code,'AUTH_CHALLENGE_INVALID');
  assert.equal((await resolveMfaChallenge({...base,challenge:'m1_'+'f'.repeat(64)})).code,
    'AUTH_CHALLENGE_INVALID');
});
test('conditional D1 insert conflict does not release a challenge handle',async()=>{
  const db=fakeDb({failChallenge:true});
  const result=await issueMfaChallenge(args(db));
  assert.equal(result.code,'AUTH_CHALLENGE_NOT_ISSUED');
  assert.equal('challenge' in result,false);
  assert.equal(db.getStored(),null);
});
test('unique unpredictable challenge handles and hashed identity are scoped',async()=>{
  const db=fakeDb();
  const a=await issueMfaChallenge(args(db));
  const hashA=db.getStored().challenge_hash;
  const identity=db.getStored().identity_hash;
  const b=await issueMfaChallenge(args(db));
  assert.equal(a.ok,true);
  assert.equal(b.ok,true);
  assert.notEqual(a.challenge,b.challenge);
  assert.notEqual(hashA,db.getStored().challenge_hash);
  assert.equal(db.getStored().identity_hash,identity);
  assert.equal(identity.includes('staff@example.invalid'),false);
});

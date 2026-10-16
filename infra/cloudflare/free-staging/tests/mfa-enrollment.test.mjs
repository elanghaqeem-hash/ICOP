import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {totpAt} from '../src/security/totp.mjs';
import {beginMfaEnrollment,confirmMfaEnrollment} from '../src/security/mfa-enrollment.mjs';
import {issueMfaChallenge} from '../src/security/mfa-challenge.mjs';
import {hashNewPassword} from '../src/security/credentials.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const now=1800000000;
const password='Some#StagingPassword2026';
const passwordHash=await hashNewPassword(password);
const original={
  id:'u-stage',tenant_id:'t-deit',email_normalized:'operator@example.invalid',
  role:'company_admin',password_hash:passwordHash,
  is_active:1,force_password_change:0,mfa_enabled:0,
  failed_logins:0,locked_until:null,token_version:1,
  mfa_secret_enc:null,mfa_pending_secret_enc:null,mfa_pending_expires_at:null,
  mfa_last_step:null
};
const env={
  ACCESS_AUD:'synthetic-aud',AUTH_V2_ENABLED:'true',
  ACCESS_IDENTITY_ENABLED:'true',ACCESS_MFA_CONFIRMED:'true',
  PASSWORD_FIRST_FACTOR_ENABLED:'true',MFA_CHALLENGE_ENABLED:'true',
  MFA_ENROLLMENT_ENABLED:'true',MFA_CONFIRM_ENABLED:'true',
  ACCESS_AUDIT_HMAC_KEY:'ab'.repeat(32),
  AUTH_CHALLENGE_HMAC_KEY:'cd'.repeat(32),
  MFA_ENCRYPTION_KEY:'ef'.repeat(32),
  MFA_RECOVERY_HMAC_KEY:'12'.repeat(32)
};
const ctx={
  access:{aud:'synthetic-aud',
    getIdentity:async()=>({email:'operator@example.invalid'})}
};
const state=()=>({
  user:{...original},challenge:null,history:[],batches:[],storedHashes:[],
  failBegin:false,failConfirm:false
});
function fakeDb(s){
  return {
    prepare(sql){return {bind(...values){
      const q={sql,values,first:async()=>{
        if(sql.includes('FROM auth_mfa_challenges WHERE challenge_hash'))
          return s.challenge;
        if(sql.includes('FROM users u INNER JOIN tenants'))return s.user;
        if(sql.includes('FROM users WHERE tenant_id=? AND id=? LIMIT 1'))
          return s.user;
        if(sql.includes('MAX(generation)'))return {current_generation:0};
        return null;
      }};
      s.history.push(q);
      return q;
    }}},
    async batch(commands){
      s.batches.push(commands.length);
      if(s.failBegin&&commands.some(c=>c.sql.includes('SET mfa_pending_secret_enc')))
        throw Error('simulated pending secret DB failure');
      if(s.failConfirm&&commands.some(c=>c.sql.includes('UPDATE auth_mfa_challenges')))
        throw Error('simulated atomic D1 failure');
      for(const c of commands){
        if(c.sql.includes('INSERT INTO auth_mfa_challenges')){
          const v=c.values;
          s.challenge={challenge_hash:v[0],tenant_id:s.user.tenant_id,
            user_id:s.user.id,purpose:v[1],identity_hash:v[2],
            issued_at:v[3],expires_at:v[4],
            token_version:s.user.token_version,consumed_at:null};
        }
        if(c.sql.includes('SET mfa_pending_secret_enc')){
          s.user.mfa_pending_secret_enc=c.values[0];
          s.user.mfa_pending_expires_at=c.values[1];
        }
        if(c.sql.includes('UPDATE auth_mfa_challenges SET consumed_at')){
          s.challenge.consumed_at=c.values[0];
        }
        if(c.sql.includes('SET mfa_enabled=1')){
          s.user.mfa_enabled=1;
          s.user.mfa_secret_enc=s.user.mfa_pending_secret_enc;
          s.user.mfa_pending_secret_enc=null;
          s.user.token_version=c.values[2];
        }
        if(c.sql.includes('INSERT INTO mfa_recovery_codes')){
          const a=c.values;
          s.storedHashes.push(a[0]);
        }
      }
      return commands.map(()=>({success:true,meta:{changes:1}}));
    }
  };
}
const issueArgs=db=>({ctx,db,env,tenantCode:'DEIT',password,
  ip:'192.0.2.8',now});
const enrollArgs=(db,challenge)=>({ctx,db,env,tenantCode:'DEIT',
  challenge,ip:'192.0.2.8',now:now+2});

test('U01 pending TOTP is encrypted in D1 and provisioning URI shown once',async()=>{
  const s=state(),db=fakeDb(s);
  const first=await issueMfaChallenge(issueArgs(db));
  assert.equal(first.ok,true);
  const setup=await beginMfaEnrollment(enrollArgs(db,first.challenge));
  assert.equal(setup.ok,true);
  assert.equal(setup.sessionIssued,false);
  assert.equal(setup.applicationAuthenticated,false);
  assert.ok(setup.provisioningUri.startsWith('otpauth://totp/'));
  assert.match(s.user.mfa_pending_secret_enc,/^aes256gcm:v1:/);
  assert.equal(s.user.mfa_enabled,0);
  assert.equal(s.user.mfa_secret_enc,null);
  assert.equal(s.storedHashes.length,0);
  assert.ok(!JSON.stringify(s.history).includes('192.0.2.8'));
  const uri=new URL(setup.provisioningUri);
  const rawSecret=uri.searchParams.get('secret');
  assert.ok(rawSecret?.length===32);
  assert.ok(!JSON.stringify(s.history).includes(rawSecret));
  const retry=await beginMfaEnrollment(enrollArgs(db,first.challenge));
  assert.equal(retry.code,'MFA_ENROLLMENT_NOT_ALLOWED');
});
test('TOTP confirmation creates ten distinct hashed recovery records, not a session',async()=>{
  const s=state(),db=fakeDb(s);
  const first=await issueMfaChallenge(issueArgs(db));
  const setup=await beginMfaEnrollment(enrollArgs(db,first.challenge));
  const secret=new URL(setup.provisioningUri).searchParams.get('secret');
  const code=await totpAt(secret,Math.floor((now+3)/30));
  const confirm=await confirmMfaEnrollment({
    ...enrollArgs(db,first.challenge),code,now:now+3
  });
  assert.equal(confirm.ok,true);
  assert.equal(confirm.mfaEnabled,true);
  assert.equal(confirm.loginRequired,true);
  assert.equal(confirm.sessionIssued,false);
  assert.equal(confirm.recoveryCodes.length,10);
  assert.equal(new Set(confirm.recoveryCodes).size,10);
  assert.equal(s.storedHashes.length,10);
  assert.ok(s.storedHashes.every(h=>/^[0-9a-f]{64}$/.test(h)));
  assert.ok(confirm.recoveryCodes.every(c=>!JSON.stringify(s.history).includes(c)));
  assert.equal(s.user.mfa_enabled,1);
  assert.equal(s.user.mfa_pending_secret_enc,null);
  assert.equal(s.challenge.consumed_at,now+3);
  assert.ok(s.batches.includes(14));
  const replay=await confirmMfaEnrollment({
    ...enrollArgs(db,first.challenge),code,now:now+4
  });
  assert.equal(replay.code,'AUTH_CHALLENGE_INVALID');
  assert.equal('recoveryCodes' in replay,false);
});
test('wrong TOTP and expiry never confirm enrollment or leak recovery codes',async()=>{
  const s=state(),db=fakeDb(s);
  const first=await issueMfaChallenge(issueArgs(db));
  await beginMfaEnrollment(enrollArgs(db,first.challenge));
  const wrong=await confirmMfaEnrollment({
    ...enrollArgs(db,first.challenge),code:'wrong'
  });
  assert.equal(wrong.code,'AUTH_INVALID');
  assert.equal('recoveryCodes' in wrong,false);
  const late=await confirmMfaEnrollment({
    ...enrollArgs(db,first.challenge),code:'123456',now:now+301
  });
  assert.equal(late.code,'AUTH_CHALLENGE_INVALID');
  assert.equal(s.user.mfa_enabled,0);
  assert.equal(s.storedHashes.length,0);
});
test('all MFA enrollment release flags disabled by default before DB lookup',async()=>{
  const s=state(),db=fakeDb(s);
  const disabled={...env,MFA_ENROLLMENT_ENABLED:undefined};
  assert.equal((await beginMfaEnrollment({
    ...enrollArgs(db,'m1_'+'a'.repeat(64)),env:disabled
  })).code,'STAGING_AUTH_NOT_READY');
  assert.equal((await confirmMfaEnrollment({
    ...enrollArgs(db,'m1_'+'a'.repeat(64)),code:'123456',
    env:{...env,MFA_CONFIRM_ENABLED:false}
  })).code,'STAGING_AUTH_NOT_READY');
  assert.equal(s.history.length,0);
});
test('DB failure on pending secret or completion denies without session',async()=>{
  const s=state(),db=fakeDb(s);
  const issued=await issueMfaChallenge(issueArgs(db));
  s.failBegin=true;
  const result=await beginMfaEnrollment(enrollArgs(db,issued.challenge));
  assert.equal(result.code,'STAGING_DB_NOT_READY');
  assert.equal(s.user.mfa_pending_secret_enc,null);
  s.failBegin=false;
  const started=await beginMfaEnrollment(enrollArgs(db,issued.challenge));
  const secret=new URL(started.provisioningUri).searchParams.get('secret');
  const code=await totpAt(secret,Math.floor((now+3)/30));
  s.failConfirm=true;
  const failed=await confirmMfaEnrollment({
    ...enrollArgs(db,issued.challenge),code,now:now+3
  });
  assert.equal(failed.code,'MFA_ENROLLMENT_FAILED');
  assert.equal('recoveryCodes' in failed,false);
  assert.equal(s.user.mfa_enabled,0);
});

test('D1 enrollment SQL binds match placeholders exactly and require challenge CAS',async()=>{
  const s=state(),db=fakeDb(s);
  const issued=await issueMfaChallenge(issueArgs(db));
  const started=await beginMfaEnrollment(enrollArgs(db,issued.challenge));
  const seed=new URL(started.provisioningUri).searchParams.get('secret');
  const code=await totpAt(seed,Math.floor((now+3)/30));
  const confirmed=await confirmMfaEnrollment({
    ...enrollArgs(db,issued.challenge),code,now:now+3
  });
  assert.equal(confirmed.ok,true);
  for(const item of s.history){
    const matches=item.sql.match(/\\?/g)||[];
    assert.equal(matches.length,item.values.length,
      'SQL parameter count mismatch: '+item.sql.slice(0,100));
  }
  const writes=s.history.map(q=>q.sql);
  assert.ok(writes.some(q=>q.includes(
    'UPDATE auth_mfa_challenges SET consumed_at') &&
    q.includes('consumed_at IS NULL')));
  assert.ok(writes.some(q=>q.includes('SET mfa_enabled=1') &&
    q.includes('token_version=?') &&
    q.includes('EXISTS(SELECT 1 FROM auth_mfa_challenges')));
  assert.ok(writes.some(q=>q.includes('INSERT INTO mfa_used_steps')));
  assert.equal(writes.filter(q=>q.includes('INSERT INTO mfa_recovery_codes')).length,10);
  assert.ok(writes.some(q=>q.includes('auth.mfa_enrolled')));
  assert.ok(!writes.some(q=>q.includes('INSERT INTO auth_sessions')));
});
test('challenge principal mismatch refuses enrollment without writing secrets',async()=>{
  const s=state(),db=fakeDb(s);
  const issued=await issueMfaChallenge(issueArgs(db));
  const historyBefore=s.history.length;
  const impostor={access:{aud:env.ACCESS_AUD,
    getIdentity:async()=>({email:'attacker@example.invalid'})}};
  const result=await beginMfaEnrollment({
    ...enrollArgs(db,issued.challenge),ctx:impostor
  });
  assert.equal(result.ok,false);
  assert.equal('provisioningUri' in result,false);
  assert.equal(s.user.mfa_pending_secret_enc,null);
  assert.ok(!s.history.slice(historyBefore).some(x=>x.sql.includes(
    'SET mfa_pending_secret_enc')));
});

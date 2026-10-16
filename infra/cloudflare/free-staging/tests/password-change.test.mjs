import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {hashNewPassword} from '../src/security/credentials.mjs';
import {changeInitialPassword} from '../src/security/password-change.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;

const OLD='Existing#2026-Staging-Password';
const NEW='Changed#2026-Staging-Password';
const now=1800000000000;
const oldHash=await hashNewPassword(OLD);
const subject={
  id:'user-deit',tenant_id:'tenant-deit',email_normalized:'operator@example.invalid',
  password_hash:oldHash,role:'company_admin',is_active:1,
  force_password_change:1,mfa_enabled:0,failed_logins:0,
  locked_until:null,token_version:3
};
const env={
  AUTH_V2_ENABLED:'true',ACCESS_IDENTITY_ENABLED:'true',
  ACCESS_MFA_CONFIRMED:'true',PASSWORD_FIRST_FACTOR_ENABLED:'true',
  PASSWORD_CHANGE_ENABLED:'true',
  ACCESS_AUD:'aud-stage-test',
  ACCESS_AUDIT_HMAC_KEY:'ab'.repeat(32)
};
const ctx={access:{aud:'aud-stage-test',
  getIdentity:async()=>({email:'OPERATOR@example.invalid'})}};
function fakeDb({user={...subject},conflict=false,failAudit=false}={}) {
  const log=[],batchCalls=[];
  const db={
    log,batchCalls,
    prepare(sql){return {
      bind(...values){
        log.push({sql,values});
        return {sql,values,
          first:async()=>user,
          run:async()=>({success:true,meta:{changes:1}})};
      }
    }},
    async batch(statements){
      batchCalls.push(statements.length);
      if(failAudit&&statements.length===3)throw Error('Simulated D1 rollback');
      return statements.map((stmt,i)=>({
        success:true,meta:{changes:conflict&&statements.length===3&&(i===0||i===2)?0:1}
      }));
    }
  };
  return db;
}
const args=db=>({
  ctx,db,tenantCode:'DEIT',currentPassword:OLD,newPassword:NEW,
  env,ip:'192.0.2.10',now
});

test('U01: valid Access + old password replaces hash and audits, never mints session',async()=>{
  const db=fakeDb();
  const result=await changeInitialPassword(args(db));
  assert.deepEqual(result,{
    ok:true,passwordChanged:true,forceMfaEnrollment:true,
    sessionIssued:false,sessionsInvalidated:true
  });
  assert.deepEqual(db.batchCalls,[2,3]);
  const log=JSON.stringify(db.log);
  assert.equal(log.includes(OLD),false);
  assert.equal(log.includes(NEW),false);
  assert.equal(log.includes('192.0.2.10'),false);
  assert.equal(log.includes('INSERT INTO auth_sessions'),false);
  assert.ok(log.includes('auth.initial_password_changed'));
  assert.ok(log.includes('UPDATE auth_sessions SET revoked_at'));
  assert.ok(log.includes('password_hash=? AND token_version=?'));
  assert.ok(log.includes('hmac-sha256:'));
  const update=db.log.find(x=>x.sql.includes('SET password_hash='));
  assert.match(update?.values[0]??'',/^pbkdf2-sha256\$600000\$/);
  assert.notEqual(update.values[0],oldHash);
});
test('release gates and forged Access are denied before any D1 access',async()=>{
  const db=fakeDb();
  assert.equal((await changeInitialPassword({...args(db),
    env:{...env,PASSWORD_CHANGE_ENABLED:'false'}})).code,'STAGING_AUTH_NOT_READY');
  assert.equal((await changeInitialPassword({...args(db),
    ctx:{access:{aud:'spoofed',getIdentity:ctx.access.getIdentity}}})).code,'ACCESS_REQUIRED');
  assert.equal((await changeInitialPassword({...args(db),
    ctx:undefined})).code,'ACCESS_REQUIRED');
  assert.equal(db.log.length,0);
});
test('wrong current password never changes hash or mints session',async()=>{
  const db=fakeDb();
  const result=await changeInitialPassword({...args(db),currentPassword:'Wrong#2026-Password'});
  assert.equal(result.code,'INVALID_CREDENTIALS');
  assert.deepEqual(db.batchCalls,[2]);
  assert.ok(!JSON.stringify(db.log).includes('SET password_hash='));
  assert.ok(JSON.stringify(db.log).includes('auth.login_failed'));
});
test('password reuse and insufficient complexity cannot replace password',async()=>{
  const reuse=fakeDb();
  assert.equal((await changeInitialPassword({...args(reuse),newPassword:OLD})).code,'PASSWORD_REUSE_DENIED');
  assert.deepEqual(reuse.batchCalls,[2]);
  const weak=fakeDb();
  assert.equal((await changeInitialPassword({...args(weak),newPassword:'short'})).code,'PASSWORD_POLICY');
  assert.deepEqual(weak.batchCalls,[2]);
});
test('no initial password change for inactive or already enrolled profile',async()=>{
  const done=fakeDb({user:{...subject,force_password_change:0,mfa_enabled:1}});
  assert.notEqual((await changeInitialPassword(args(done))).ok,true);
  assert.deepEqual(done.batchCalls,[2]);
  const inactive=fakeDb({user:{...subject,is_active:0}});
  assert.equal((await changeInitialPassword(args(inactive))).code,'INVALID_CREDENTIALS');
  assert.deepEqual(inactive.batchCalls,[]);
});
test('CAS race is denied and D1 transaction exception does not report success',async()=>{
  const race=fakeDb({conflict:true});
  assert.equal((await changeInitialPassword(args(race))).code,'PASSWORD_CHANGE_CONFLICT');
  const failing=fakeDb({failAudit:true});
  assert.equal((await changeInitialPassword(args(failing))).code,'STAGING_DB_NOT_READY');
  assert.ok(!JSON.stringify(race.log).includes(NEW));
  assert.ok(!JSON.stringify(failing.log).includes(NEW));
});

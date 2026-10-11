import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { encryptTotpSecret, newTotpSecret } from '../src/security/credentials.mjs';
import { totpAt } from '../src/security/totp.mjs';
import { finishTotpAndIssueSession, issueRecoveryAfterMfa, resetUserMfa } from '../src/security/auth-lifecycle.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const now=1800000000;
const key='ab'.repeat(32), auditKey='bc'.repeat(32), sessionKey='cd'.repeat(32), recoveryKey='de'.repeat(32);
const tenantId='tenant-deit',userId='staff-test';
const ip='192.0.2.10';
const subject={tenantId,userId,ip};
const keys={session:sessionKey,encryption:key,audit:auditKey};
const actor={id:'admin-1',tenantId,role:'company_admin',isActive:true,forcePasswordChange:false,mfaEnabled:true,mfaVerified:true};

function fakeDb({user,target,batchFail=false,changesOverride}={}) {
  const calls=[];
  return {
    calls,
    prepare(sql) {
      return { bind(...args) {
        calls.push({sql,args});
        return {
          first:async()=>{
            if(sql.includes('MAX(generation)'))return {maximum:0};
            if(sql.includes('FROM users'))return sql.includes('token_version FROM users')&&target?target:user;
            return null;
          },
        };
      }};
    },
    async batch(commands){
      calls.push({batchSize:commands.length});
      if(batchFail)throw Error('synthetic D1 transaction exception');
      return commands.map((_,idx)=>({success:true,meta:{changes:changesOverride?.[idx]??1}}));
    },
  };
}
async function totpFixture() {
  const secret=newTotpSecret();
  return {
    secret,
    encrypted:await encryptTotpSecret({secret,keyHex:key,tenantId,userId}),
    code:await totpAt(secret,now/30),
  };
}
const userBase={id:userId,tenant_id:tenantId,role:'company_admin',
  is_active:1,force_password_change:0,mfa_enabled:1,mfa_last_step:null,
  token_version:3};

test('U01: verified TOTP creates one keyed-hash session and append-only audit in a D1 transaction',async()=>{
  const f=await totpFixture();
  const db=fakeDb({user:{...userBase,mfa_secret_enc:f.encrypted}});
  const result=await finishTotpAndIssueSession({db,...subject,code:f.code,keys,now});
  assert.equal(result.ok,true);
  assert.match(result.sessionToken,/^s1_[a-f0-9]{64}$/);
  assert.equal(result.expiresAt,now+28800);
  assert.deepEqual(db.calls.find(c=>'batchSize'in c),{batchSize:4});
  const stored=JSON.stringify(db.calls);
  assert.ok(!stored.includes(result.sessionToken),'raw session must never be persisted');
  assert.ok(!stored.includes(f.secret),'MFA secret must not be written in plaintext');
  assert.ok(!stored.includes(ip),'client IP must only be keyed pseudonym');
  assert.ok(stored.includes('hmac-sha256:'));
});
test('U01: no MFA means no session; same TOTP replay/transaction failure denies',async()=>{
  const f=await totpFixture();
  const invalid=await finishTotpAndIssueSession({
    db:fakeDb({user:{...userBase,mfa_enabled:0,mfa_secret_enc:f.encrypted}}),
    ...subject,code:f.code,keys,now,
  });
  assert.equal(invalid.code,'AUTH_NOT_ALLOWED');
  const locked=await finishTotpAndIssueSession({
    db:fakeDb({user:{...userBase,force_password_change:1,mfa_secret_enc:f.encrypted}}),
    ...subject,code:f.code,keys,now,
  });
  assert.equal(locked.code,'AUTH_NOT_ALLOWED');
  const reused=await finishTotpAndIssueSession({
    db:fakeDb({user:{...userBase,mfa_last_step:now/30,mfa_secret_enc:f.encrypted}}),
    ...subject,code:f.code,keys,now,
  });
  assert.equal(reused.code,'MFA_INVALID');
  const dbFailed=await finishTotpAndIssueSession({
    db:fakeDb({user:{...userBase,mfa_secret_enc:f.encrypted},batchFail:true}),
    ...subject,code:f.code,keys,now,
  });
  assert.equal(dbFailed.ok,false);
  const noKey=await finishTotpAndIssueSession({db:fakeDb(),...subject,code:f.code,keys:{},now});
  assert.equal(noKey.code,'AUTH_KEYS_NOT_CONFIGURED');
});
test('U01: recovery generation contains exactly ten only-hash D1 inserts',async()=>{
  const db=fakeDb({user:{is_active:1,mfa_enabled:1}});
  const x=await issueRecoveryAfterMfa({db,tenantId,userId,
    key:recoveryKey,ip,auditKey,now});
  assert.equal(x.ok,true);
  assert.equal(x.recoveryCodes.length,10);
  assert.equal(new Set(x.recoveryCodes).size,10);
  assert.deepEqual(db.calls.find(c=>'batchSize'in c),{batchSize:12});
  const inserts=db.calls.filter(c=>typeof c.sql==='string'&&c.sql.startsWith('INSERT INTO mfa_recovery_codes'));
  assert.equal(inserts.length,10);
  assert.ok(inserts.every(c=>c.args[3]===1),'10 codes must share one issuance generation');
  for(const code of x.recoveryCodes)assert.ok(!JSON.stringify(inserts).includes(code));
  const failed=await issueRecoveryAfterMfa({db:fakeDb({user:{is_active:1,mfa_enabled:1},batchFail:true}),tenantId,userId,key:recoveryKey,ip,auditKey,now});
  assert.equal(failed.ok,false);
});
test('U02/U24: MFA reset revokes all sessions, revokes codes and audits reason',async()=>{
  const target={id:'target-user',tenant_id:tenantId,is_active:1,token_version:3};
  const db=fakeDb({target});
  const r=await resetUserMfa({db,actor,targetId:target.id,
    reason:'Confirmed lost device by authorized admin',ip,auditKey,now});
  assert.equal(r.ok,true);
  assert.equal(r.sessionsRevoked,true);
  const stmts=db.calls.map(x=>x.sql||'');
  assert.ok(stmts.some(x=>x.includes('token_version=?')));
  assert.ok(stmts.some(x=>x.includes('auth_sessions SET revoked_at')));
  assert.ok(stmts.some(x=>x.includes('mfa_recovery_codes SET revoked_at')));
  assert.ok(stmts.some(x=>x.includes('auth.mfa_reset')));
  assert.ok(!JSON.stringify(db.calls).includes(ip));
  const self=await resetUserMfa({db:fakeDb({target:{...target,id:actor.id}}),actor,
    targetId:actor.id,reason:'Confirmed lost device by authorized admin',ip,auditKey,now});
  assert.equal(self.code,'SELF_RESET_FORBIDDEN');
  const cross=await resetUserMfa({db:fakeDb({target:{...target,tenant_id:'tenant-other'}}),
    actor,targetId:target.id,reason:'Confirmed lost device by authorized admin',
    ip,auditKey,now});
  assert.equal(cross.code,'TENANT_DENIED');
  const unauthorized=await resetUserMfa({db:fakeDb({target}),actor:{...actor,role:'customer_user'},
    targetId:target.id,reason:'Confirmed lost device by authorized admin',ip,auditKey,now});
  assert.equal(unauthorized.code,'PERMISSION_DENIED');
});

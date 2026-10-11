import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { newSessionToken, hashSessionToken, verifySession } from '../src/security/session.mjs';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const key='1a'.repeat(32); // Synthetic test key ONLY
const now=1_800_000_000;
const baseRow={
  tenant_id:'tenant-a',user_id:'user-a',token_version:0,
  session_version:2,user_version:2,mfa_verified:1,
  issued_at:now-100,expires_at:now+100,revoked_at:null,
  role:'company_admin',is_active:1,force_password_change:0,mfa_enabled:1,
};
const store=(row)=>({prepare:(sql)=>({bind:(digest)=>({first:async()=>row})})});
const opts=(row,tenant='tenant-a',perm='user.manage')=>verifySession(
  store(row),credential,key,tenant,perm,now);
const credential='s1_'+'ac'.repeat(32);

test('cryptographically randomized tokens and tenant-scoped keyed digest',async()=>{
  const a=newSessionToken(),b=newSessionToken();
  assert.match(a,/^s1_[a-f0-9]{64}$/);
  assert.notEqual(a,b);
  const h=await hashSessionToken(a,key);
  assert.match(h,/^[a-f0-9]{64}$/);
  assert.notEqual(h,a);
  assert.notEqual(h,await hashSessionToken(a,'2b'.repeat(32)));
  assert.equal(await hashSessionToken('invalid',key),null);
});
test('allow only live authoritative tenant-scoped session with permissions',async()=>{
  const result=await opts(baseRow);
  assert.equal(result.ok,true);
  assert.deepEqual(result.actor,{id:'user-a',tenantId:'tenant-a',role:'company_admin',mfaVerified:true});
  assert.equal((await opts(baseRow,'tenant-b')).code,'SESSION_INVALID');
});
test('expiry, revocation, rotation and inactive sessions fail',async()=>{
  for (const row of [
    {...baseRow,expires_at:now},
    {...baseRow,issued_at:now+1},
    {...baseRow,revoked_at:now-10},
    {...baseRow,user_version:3},
    {...baseRow,is_active:0},
  ]) assert.equal((await opts(row)).ok,false);
  assert.equal((await opts(null)).code,'SESSION_INVALID');
});
test('MFA and first-login gates precede permissions; approval SoD enforced',async()=>{
  assert.equal((await opts({...baseRow,mfa_verified:0})).code,'MFA_REQUIRED');
  assert.equal((await opts({...baseRow,force_password_change:1})).code,'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await opts({...baseRow,role:'super_admin'},'tenant-a','approval.decide')).code,'PERMISSION_DENIED');
});
test('stale MFA-verified session denied if account MFA enrollment has been removed',async()=>{
  const contradiction={...baseRow,mfa_enabled:0,mfa_verified:1};
  const result=await opts(contradiction);
  assert.equal(result.ok,false);
  assert.equal(result.code,'MFA_REQUIRED');
});

test('DB exceptions, malformed tokens, invalid key fail closed',async()=>{
  const db={prepare:()=>{throw Error('db is offline')}};
  assert.equal((await verifySession(db,credential,key,'tenant-a','user.manage',now)).code,'SESSION_DB_UNAVAILABLE');
  assert.equal((await verifySession(db,'invalid',key,'tenant-a','user.manage',now)).code,'SESSION_INVALID');
  assert.equal((await verifySession(db,credential,'weak','tenant-a','user.manage',now)).code,'SESSION_INVALID');
});

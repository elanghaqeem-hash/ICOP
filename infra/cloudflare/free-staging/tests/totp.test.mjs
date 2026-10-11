import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { totpAt, matchTotp, reserveTotpStep } from '../src/security/totp.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // RFC test key, NOT a credential

test('RFC 6238 reference SHA1 vectors, six-digit reduction',async()=>{
  assert.equal(await totpAt(secret,1),'287082');
  assert.equal(await totpAt(secret,Math.floor(1111111109/30)),'081804');
  assert.equal(await totpAt(secret,Math.floor(1111111111/30)),'050471');
});
test('accept at ±1 period; reject outside window and reused steps',async()=>{
  const now=59_000; // RFC step 1
  const c0=await totpAt(secret,0),c1=await totpAt(secret,1),c2=await totpAt(secret,2),c3=await totpAt(secret,3);
  assert.equal(await matchTotp(secret,c0,-1,now),0);
  assert.equal(await matchTotp(secret,c1,-1,now),1);
  assert.equal(await matchTotp(secret,c2,-1,now),2);
  assert.equal(await matchTotp(secret,c3,-1,now),null);
  assert.equal(await matchTotp(secret,c1,1,now),null);
  assert.equal(await matchTotp(secret,'1234567',-1,now),null);
  assert.equal(await matchTotp(secret,123456,-1,now),null);
});
test('reject malformed secret without leaking key material',async()=>{
  await assert.rejects(()=>totpAt('NOT-BASE32!',1),/Invalid TOTP secret/);
  await assert.rejects(()=>totpAt('ABC',1),/Invalid TOTP secret/);
});
test('reserve used step exactly once, fail closed on DB errors',async()=>{
  const seen=new Set();
  const db={prepare:()=>({bind:(tenant,user,step,time)=>({run:async()=>{
    const id=[tenant,user,step].join('|');
    if (seen.has(id)) throw new Error('UNIQUE constraint failed');
    seen.add(id);
    return {success:true,meta:{changes:1}};
  }})})};
  assert.equal(await reserveTotpStep(db,'tenant-a','user-a',10,100),true);
  assert.equal(await reserveTotpStep(db,'tenant-a','user-a',10,101),false);
  assert.equal(await reserveTotpStep(db,'tenant-b','user-a',10,101),true);
  assert.equal(await reserveTotpStep(null,'tenant-a','user-a',11,102),false);
  assert.equal(await reserveTotpStep(db,'tenant-a','user-a',-1,102),false);
});
test('mismatched D1 execution result may not authorize MFA',async()=>{
  const db={prepare:()=>({bind:()=>({run:async()=>({success:true,meta:{changes:0}})})})};
  assert.equal(await reserveTotpStep(db,'tenant-a','user-a',9),false);
});

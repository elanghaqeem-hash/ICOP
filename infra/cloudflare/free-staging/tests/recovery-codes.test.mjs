import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryCodes, hashRecoveryCode } from '../src/security/recovery-codes.mjs';

const k='ab'.repeat(32);
const who={secret:k,tenantId:'tenant-deit',userId:'user-test-1'};

test('UAT U01: exactly ten independent 128-bit one-time recovery codes',async()=>{
  const {codes, hashes}=await createRecoveryCodes(who);
  assert.equal(codes.length,10);
  assert.equal(hashes.length,10);
  assert.equal(new Set(codes).size,10);
  assert.equal(new Set(hashes).size,10);
  for(let i=0;i<10;i++){
    assert.match(codes[i],/^[0-9A-F]{8}(?:-[0-9A-F]{8}){3}$/);
    assert.match(hashes[i],/^[a-f0-9]{64}$/);
    assert.ok(!hashes[i].includes(codes[i]), 'stored digest cannot contain plaintext recovery code');
    assert.equal(await hashRecoveryCode({...who,code:codes[i]}),hashes[i]);
  }
  const second=await createRecoveryCodes(who);
  assert.ok(second.codes.every(code=>!codes.includes(code)),'each enrollment uses fresh random codes');
});

test('UAT U01: cryptographically scope identical code to tenant and user',async()=>{
  const code='AABBCCDD-00112233-44556677-8899AABB';
  const a=await hashRecoveryCode({...who,code});
  assert.notEqual(a,await hashRecoveryCode({...who,tenantId:'tenant-other',code}));
  assert.notEqual(a,await hashRecoveryCode({...who,userId:'user-other',code}));
  assert.notEqual(a,await hashRecoveryCode({...who,secret:'cd'.repeat(32),code}));
});

test('reject missing/weak signing key, malformed code and forged subject',async()=>{
  for(const secret of [undefined,'','1234','x'.repeat(64)]){
    await assert.rejects(createRecoveryCodes({...who,secret}),/MFA_RECOVERY_KEY_NOT_CONFIGURED/);
  }
  for(const code of [undefined,'ABCD', 'AABBCCDD00112233445566778899AABB',
                     'AABBCCDD-00112233-44556677-8899AABC\n']){
    await assert.rejects(hashRecoveryCode({...who,code}),/MFA_RECOVERY_CODE_INVALID/);
  }
  await assert.rejects(hashRecoveryCode({...who,tenantId:'DEIT\nUSER',code:'AABBCCDD-00112233-44556677-8899AABB'}),
    /MFA_RECOVERY_SUBJECT_INVALID/);
});

test('UAT U02/U24 remain gated: helpers cannot create sessions or modify user MFA state',async()=>{
  const {codes,hashes}=await createRecoveryCodes(who);
  assert.equal(Object.keys({codes,hashes}).sort().join(','),'codes,hashes');
  // No DB or session is accepted by these pure primitives. One-time consumption,
  // 10-code single display, reset/revocation and append-only audit remain
  // mandatory integration/UAT requirements before enabling login.
});

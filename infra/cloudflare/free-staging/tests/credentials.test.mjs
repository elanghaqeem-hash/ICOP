import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { hashNewPassword, verifyNewPassword, newTotpSecret, encryptTotpSecret, decryptTotpSecret, totpUri } from '../src/security/credentials.mjs';
import { totpAt } from '../src/security/totp.mjs';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const key='ab'.repeat(32),tenantId='tenant-deit',userId='admin-test';
test('WebCrypto AES-GCM secret is randomized, encrypted and tenant/user bound',async()=>{
  const secret=newTotpSecret();
  assert.match(secret,/^[A-Z2-7]{32}$/);
  const x=await encryptTotpSecret({secret,keyHex:key,tenantId,userId});
  const y=await encryptTotpSecret({secret,keyHex:key,tenantId,userId});
  assert.notEqual(x,y);
  assert.ok(!x.includes(secret));
  assert.equal(await decryptTotpSecret({encrypted:x,keyHex:key,tenantId,userId}),secret);
  await assert.rejects(decryptTotpSecret({encrypted:x,keyHex:key,tenantId:'other-tenant',userId}),/MFA_CIPHERTEXT_INVALID/);
  await assert.rejects(decryptTotpSecret({encrypted:x,keyHex:'dc'.repeat(32),tenantId,userId}),/MFA_CIPHERTEXT_INVALID/);
  await assert.rejects(decryptTotpSecret({encrypted:x.slice(0,-3)+'001',keyHex:key,tenantId,userId}),/MFA_CIPHERTEXT_INVALID/);
  assert.match(totpUri(secret,'test@example.invalid'),/^otpauth:\/\/totp\//);
  assert.match(await totpAt(secret,60000000),/^\d{6}$/);
});
test('invalid or absent encryption keys are rejected and no plaintext secret is persisted',async()=>{
  const secret=newTotpSecret();
  await assert.rejects(encryptTotpSecret({secret,keyHex:'weak',tenantId,userId}),/MFA_ENCRYPTION_KEY_NOT_CONFIGURED/);
  await assert.rejects(encryptTotpSecret({secret,keyHex:key,tenantId:'bad/name',userId}),/MFA_SUBJECT_INVALID/);
});
test('new staging passwords use salted high-work-factor KDF with strict policy',async()=>{
  await assert.rejects(hashNewPassword('password123'),/PASSWORD_POLICY/);
  const pw='Strong#StagingPassword2026!';
  const a=await hashNewPassword(pw),b=await hashNewPassword(pw);
  assert.notEqual(a,b);
  assert.match(a,/^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifyNewPassword(pw,a),true);
  assert.equal(await verifyNewPassword('Wrong#StagingPassword2026!',a),false);
  assert.equal(await verifyNewPassword(pw,'$2a$12$legacy-bcrypt-is-not-valid'),false);
  assert.equal(await verifyNewPassword(pw,'corrupt'),false);
});

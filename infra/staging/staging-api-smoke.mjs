// Executed ONLY inside the throwaway CI API container after manual seed.
// No tokens, passwords or account details are printed to CI logs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

assert.equal(process.env.NODE_ENV, 'production');
assert.equal(process.env.DB_NAME, 'icop_staging_ci');
assert.ok(process.env.SEED_PASSWORD?.length >= 16, 'Synthetic CI password required');

async function call(path, method = 'GET', body, token) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const response = await fetch('http://127.0.0.1:3001' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  let data = {};
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

const login = await call('/api/v1/auth/login', 'POST', {
  tenant: 'DEIT',
  email: 'sales@defendit360.com',
  password: process.env.SEED_PASSWORD,
});
assert.equal(login.status, 200, 'Synthetic sales login must succeed');
assert.ok(login.data.token, 'Server-issued JWT required');

const blocked = await call('/api/v1/ai/features', 'GET', undefined, login.data.token);
assert.equal(blocked.status, 403, 'Password-change-required token may not read business settings');
assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');

const changed = await call('/api/v1/auth/change-password', 'POST', {
  currentPassword: process.env.SEED_PASSWORD,
  newPassword: 'Aa9!' + randomBytes(20).toString('hex'),
}, login.data.token);
assert.equal(changed.status, 200, 'First-login password rotation must work');
assert.ok(changed.data.token, 'Password rotation must issue a new JWT');

const stale = await call('/api/v1/ai/features', 'GET', undefined, login.data.token);
assert.equal(stale.status, 401, 'Previous JWT must be revoked after changing password');

const me = await call('/api/v1/auth/me', 'GET', undefined, changed.data.token);
assert.equal(me.status, 200, 'Authenticated user profile must be reachable after rotation');
assert.equal(me.data.forcePasswordChange, false);

const features = await call('/api/v1/ai/features', 'GET', undefined, changed.data.token);
assert.equal(features.status, 200, 'User should be able to read effective tenant AI settings');
const tenderCompliance = features.data.items?.find(item => item.feature === 'tender_compliance');
assert.ok(tenderCompliance, 'Tender compliance AI feature must be present');
assert.equal(tenderCompliance.effective, false,
  'Tender compliance AI must remain disabled without explicit tenant admin opt-in');

console.log('PASS: live API login, password-change gate, JWT revocation and tenant AI default OFF');

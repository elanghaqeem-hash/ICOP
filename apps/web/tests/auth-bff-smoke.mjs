// End-to-end HTTP smoke against a real built Next.js BFF and a mock upstream.
// Does not require a live DB; tests the browser-to-BFF trust boundary.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const base = 'http://127.0.0.1:3097';
const calls = [];
const user = { id: 'user-1', email: 'test@example.invalid', fullName: 'Test User', role: 'sales', customerId: null, forcePasswordChange: false };

const mock = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  calls.push({ path: req.url, method: req.method, headers: req.headers, body });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/v1/auth/login') res.end(JSON.stringify({ token: 'server-only-jwt', user }));
  else if (req.url === '/api/v1/auth/change-password') res.end(JSON.stringify({ token: 'rotated-jwt' }));
  else if (req.url === '/api/v1/auth/me') res.end(JSON.stringify({ ...user, permissions: ['dashboard.read'] }));
  else if (req.url === '/api/v1/reports/export') {
    res.setHeader('content-type', 'text/csv');
    res.setHeader('content-disposition', 'attachment; filename="report.csv"');
    res.end('hello,world');
  } else res.end(JSON.stringify({ ok: true, echoedLength: body.length }));
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const port = mock.address().port;
const next = spawn('node', ['node_modules/next/dist/bin/next', 'start', '-p', '3097', '-H', '127.0.0.1'],
  { env: { ...process.env, NODE_ENV: 'production', API_INTERNAL_URL: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
next.stdout.on('data', (d) => { stdout = (stdout + d.toString()).slice(-2500); });
next.stderr.on('data', (d) => { stdout = (stdout + d.toString()).slice(-2500); });

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    if (next.exitCode !== null) throw new Error('Next server exited: ' + stdout);
    try { const r = await fetch(base + '/login'); if (r.status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Next server did not start: ' + stdout);
}
const send = (path, method = 'GET', { cookie = '', csrf = '', origin = base, body, type = 'application/json', extra = {} } = {}) => {
  const headers = { ...extra };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-icop-csrf'] = csrf;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = type;
  return fetch(base + path, { method, headers, body, redirect: 'manual' });
};
const fromCookies = (r) => r.headers.getSetCookie().map((v) => v.split(';')[0]).join('; ');
const extract = (cookie, name) => {
  const match = cookie.split('; ').find((v) => v.startsWith(name + '='));
  assert.ok(match, 'missing cookie ' + name);
  return match.slice(name.length + 1);
};

try {
  await waitReady();
  // Browser must not be given the JWT after login.
  const badOrigin = await send('/api/v1/auth/login', 'POST',
    { origin: 'https://attacker.invalid', body: JSON.stringify({ email: user.email, password: 'placeholder' }) });
  if (badOrigin.status !== 403) console.error('BFF origin check diagnostic:', badOrigin.status, await badOrigin.clone().text(), stdout);
  assert.equal(badOrigin.status, 403);
  const login = await send('/api/v1/auth/login', 'POST', { body: JSON.stringify({ email: user.email, password: 'placeholder' }) });
  assert.equal(login.status, 200);
  const data = await login.json();
  assert.equal(data.user.id, user.id);
  assert.ok(!('token' in data), 'JWT leaked to browser body');
  const set = login.headers.getSetCookie();
  assert.ok(set.some((v) => v.startsWith('__Host-icop-session=') && v.includes('HttpOnly') && v.includes('Secure')));
  assert.ok(set.some((v) => v.startsWith('__Host-icop-csrf=') && !v.includes('HttpOnly') && v.includes('Secure')));
  const cookie = fromCookies(login);
  const csrf = extract(cookie, '__Host-icop-csrf');
  const me = await send('/api/v1/auth/me', 'GET', { cookie });
  assert.equal((await me.json()).id, user.id);
  assert.equal(calls.at(-1).headers.authorization, 'Bearer server-only-jwt');

  const missing = await send('/api/v1/test-resource', 'POST', { cookie, body: '{}' });
  assert.equal(missing.status, 403);
  const wrong = await send('/api/v1/test-resource', 'POST', { cookie, csrf: 'invalid', body: '{}' });
  assert.equal(wrong.status, 403);
  const foreign = await send('/api/v1/test-resource', 'POST', { cookie, csrf, origin: 'https://attacker.invalid', body: '{}' });
  assert.equal(foreign.status, 403);
  const created = await send('/api/v1/test-resource', 'POST', { cookie, csrf, body: '{"test":true}', extra: { 'idempotency-key': 'idem-123' } });
  assert.equal(created.status, 200);
  assert.equal(calls.at(-1).headers['idempotency-key'], 'idem-123');
  assert.equal(calls.at(-1).headers.authorization, 'Bearer server-only-jwt');

  const form = Buffer.from('TEST-MULTIPART');
  const upload = await send('/api/v1/documents/upload', 'POST',
    { cookie, csrf, body: form, type: 'multipart/form-data; boundary=abcd' });
  assert.equal(upload.status, 200);
  assert.equal(calls.at(-1).body.toString(), 'TEST-MULTIPART');

  const downloaded = await send('/api/v1/reports/export', 'GET', { cookie });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-disposition'), 'attachment; filename="report.csv"');
  assert.equal(await downloaded.text(), 'hello,world');

  const change = await send('/api/v1/auth/change-password', 'POST', { cookie, csrf, body: '{}' });
  assert.equal(change.status, 200);
  assert.deepEqual(await change.json(), { ok: true });
  const rotated = fromCookies(change);
  assert.equal(extract(rotated, '__Host-icop-session'), 'rotated-jwt');
  const rotatedCsrf = extract(rotated, '__Host-icop-csrf');
  const all = await send('/api/v1/auth/logout-all', 'POST', { cookie: rotated, csrf: rotatedCsrf });
  assert.equal(all.status, 200);
  assert.ok(all.headers.getSetCookie().some((v) => v.startsWith('__Host-icop-session=') && v.includes('Max-Age=0')));
  const noSession = await send('/api/v1/auth/me', 'GET');
  assert.equal(noSession.status, 401);

  const webhook = await send('/api/v1/esign/webhook/sandbox', 'POST',
    { origin: '', type: 'application/json', body: '{"event":"SIGNED"}', extra: { 'x-signature': 'test-hmac' } });
  assert.equal(webhook.status, 200);
  assert.equal(calls.at(-1).headers['x-signature'], 'test-hmac');
  assert.ok(!calls.at(-1).headers.authorization, 'webhook should not reuse browser cookie');
  console.log('BFF HTTP security smoke PASS (login, credentials, csrf, upload, download, rotation, logout-all, webhook)');
} finally {
  next.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  mock.close();
}

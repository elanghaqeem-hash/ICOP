// UAT U01/U25: missing production backend must be explicit and fail-closed.
// A browser should never receive a false password error or wait on localhost.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 3098;
const origin = 'http://127.0.0.1:' + port;
const env = { ...process.env, NODE_ENV: 'production', APP_PUBLIC_ORIGIN: origin };
delete env.API_INTERNAL_URL;
const next = spawn('node', ['node_modules/next/dist/bin/next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
  env, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [next.stdout, next.stderr]) stream.on('data', (d) => { logs = (logs + d).slice(-2500); });
const timeoutMs = 18000;

try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (next.exitCode !== null) throw new Error('Next exited: ' + logs);
    try {
      const r = await fetch(origin + '/login', { signal: AbortSignal.timeout(1800) });
      if (r.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(ready, 'Next server failed to start: ' + logs);

  const post = (from) => fetch(origin + '/api/v1/auth/login', {
    method: 'POST', headers: { origin: from, 'content-type': 'application/json' },
    body: JSON.stringify({ tenant: 'DEIT', email: 'nobody@example.invalid', password: 'placeholder' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const badOrigin = await post('https://untrusted.invalid');
  assert.equal(badOrigin.status, 403, 'origin protection must run before backend readiness');
  assert.equal((await badOrigin.json()).code, 'ORIGIN_MISMATCH');

  const start = Date.now();
  const response = await post(origin);
  assert.equal(response.status, 503, 'missing backend should return 503, not a 1101/502 or auth failure');
  assert.ok(Date.now() - start < 8000, 'missing backend must fail quickly');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.code, 'API_NOT_CONFIGURED');
  assert.ok(!JSON.stringify(data).includes('localhost:3001'), 'internal default must not leak');

  const unauthorized = await fetch(origin + '/api/v1/auth/me');
  assert.equal(unauthorized.status, 401, 'existing session security must not be bypassed');
  console.log('UAT U01/U25 frontend backend-readiness smoke PASS');
} finally {
  next.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
}

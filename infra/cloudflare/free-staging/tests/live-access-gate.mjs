// Public, anonymous smoke test for the Cloudflare Access staging perimeter.
// No private credentials are used or disclosed.
import assert from 'node:assert/strict';

const base = 'https://icop-staging-api.elang-haqeem.workers.dev';
const paths = ['/health', '/api/v1/system/readiness', '/api/v1/auth/access-me'];
const denied = new Set([301,302,303,307,308,401,403]);
for (const path of paths) {
  const response = await fetch(base + path, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(denied.has(response.status),
    path + ': anonymous traffic was not blocked, status=' + response.status);
  if (response.status >= 300 && response.status < 400) {
    const target = new URL(response.headers.get('location') || '', base);
    assert.ok(target.hostname.endsWith('.cloudflareaccess.com') ||
      (target.hostname === new URL(base).hostname && target.pathname.startsWith('/cdn-cgi/access/')),
      path + ': login redirect is unexpected');
  }
  console.log('PASS: anonymous access blocked for ' + path + ' (HTTP ' + response.status + ')');
}
console.log('This does not confirm authenticated login or MFA.');

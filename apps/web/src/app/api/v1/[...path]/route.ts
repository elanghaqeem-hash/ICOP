import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

// Browser tokens never pass through client JavaScript. Only this same-origin
// Next.js BFF reads the httpOnly session cookie and injects bearer auth upstream.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const production = process.env.NODE_ENV === 'production';
const SESSION = production ? '__Host-icop-session' : 'icop-dev-session';
const CSRF = production ? '__Host-icop-csrf' : 'icop-dev-csrf';
const MAX_AGE = 8 * 60 * 60;
// Production must never silently proxy credentials to loopback when the API is missing.
const API_ORIGIN = process.env.API_INTERNAL_URL?.trim() || (production ? null : 'http://localhost:3001');
type Context = { params: Promise<{ path: string[] }> };
const methodsWithoutBody = new Set(['GET', 'HEAD']);

function error(status: number, code: string) {
  return NextResponse.json({ code, message: code }, { status, headers: { 'cache-control': 'no-store' } });
}

function checkToken(expected: string | undefined, supplied: string | null) {
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function setSessionCookies(response: NextResponse, token: string) {
  response.cookies.set(SESSION, token, {
    httpOnly: true, secure: production, sameSite: 'lax', path: '/', maxAge: MAX_AGE,
  });
  response.cookies.set(CSRF, randomBytes(32).toString('hex'), {
    httpOnly: false, secure: production, sameSite: 'lax', path: '/', maxAge: MAX_AGE,
  });
}

function clearSessionCookies(response: NextResponse) {
  for (const name of [SESSION, CSRF]) {
    response.cookies.set(name, '', { path: '/', maxAge: 0, secure: production, sameSite: 'lax', httpOnly: name === SESSION });
  }
}

async function proxy(request: NextRequest, context: Context): Promise<NextResponse> {
  const { path } = await context.params;
  if (!path?.length || path.some((s) => !s || s === '.' || s === '..' || s.includes('/'))) {
    return error(400, 'INVALID_API_PATH');
  }
  const suffix = path.join('/');
  const login = suffix === 'auth/login' && request.method === 'POST';
  const changePassword = suffix === 'auth/change-password' && request.method === 'POST';
  const mfaFinish = (suffix === 'auth/mfa/enable' || suffix === 'auth/mfa/verify' || suffix === 'auth/mfa/step-up') && request.method === 'POST';
  const logout = suffix === 'auth/logout' && request.method === 'POST';
  const logoutAll = suffix === 'auth/logout-all' && request.method === 'POST';
  // The public e-sign webhook is authenticated upstream with a provider HMAC.
  // No other path is exempt from browser Origin / anti-CSRF checks.
  const webhook = request.method === 'POST' && /^esign\/webhook\/(sandbox|vida)$/.test(suffix);
  const unsafe = !methodsWithoutBody.has(request.method);

  if (unsafe && !webhook) {
    // On HTTPS ingress/reverse proxies, Next's internal request URL may have
    // a different scheme/host from the browser. Set APP_PUBLIC_ORIGIN in stage/prod.
    const publicOrigin = process.env.APP_PUBLIC_ORIGIN ?? request.nextUrl.origin;
    if (request.headers.get('origin') !== publicOrigin ||
        request.headers.get('sec-fetch-site') === 'cross-site') return error(403, 'ORIGIN_MISMATCH');
    if (request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return error(415, 'UNSUPPORTED_MEDIA_TYPE');
    if (!login && !checkToken(request.cookies.get(CSRF)?.value, request.headers.get('x-icop-csrf'))) {
      return error(403, 'CSRF_INVALID');
    }
  }

  if (logout) {
    const response = NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    clearSessionCookies(response);
    return response;
  }

  const token = request.cookies.get(SESSION)?.value;
  if (!token && !login && !webhook) return error(401, 'UNAUTHENTICATED');

  if (!API_ORIGIN) return error(503, 'API_NOT_CONFIGURED');
  let url: URL;
  try { url = new URL(API_ORIGIN); } catch { return error(503, 'API_ORIGIN_INVALID'); }
  if (!['https:', 'http:'].includes(url.protocol)) return error(503, 'API_ORIGIN_INVALID');
  url.pathname = '/api/v1/' + path.map(encodeURIComponent).join('/');
  url.search = request.nextUrl.search;
  const headers = new Headers();
  for (const name of ['content-type', 'idempotency-key', 'x-signature']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (token && !login && !webhook) headers.set('authorization', 'Bearer ' + token);

  let upstream: Response;
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method, headers, cache: 'no-store', redirect: 'manual',
    };
    if (!methodsWithoutBody.has(request.method) && request.body) {
      init.body = request.body;
      init.duplex = 'half';
    }
    upstream = await fetch(url, init);
  } catch {
    return error(502, 'API_UNAVAILABLE');
  }

  // The backend keeps returning bearer tokens to non-browser API consumers.
  // The BFF removes them before the browser sees any response body.
  if (upstream.ok && (login || changePassword || mfaFinish)) {
    let data: { token?: string; user?: unknown; mfaRequired?: boolean; mfaEnrolled?: boolean };
    try { data = await upstream.json(); } catch { return error(502, 'INVALID_AUTH_RESPONSE'); }
    if (!data.token || (login && !data.user)) return error(502, 'INVALID_AUTH_RESPONSE');
    // A short-lived MFA challenge is also an httpOnly cookie. Never reveal any
    // bearer JWT (including challenge tokens) to client JavaScript.
    const response = NextResponse.json({
      ...(login || mfaFinish ? { user: data.user } : { ok: true }),
      mfaRequired: !!data.mfaRequired, mfaEnrolled: !!data.mfaEnrolled,
    }, { headers: { 'cache-control': 'no-store' } });
    setSessionCookies(response, data.token);
    return response;
  }

  const responseHeaders = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  for (const name of ['content-type', 'content-disposition']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const response = new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
  if (logoutAll && upstream.ok) clearSessionCookies(response);
  return response;
}

export async function GET(req: NextRequest, ctx: Context) { return proxy(req, ctx); }
export async function POST(req: NextRequest, ctx: Context) { return proxy(req, ctx); }
export async function PUT(req: NextRequest, ctx: Context) { return proxy(req, ctx); }
export async function PATCH(req: NextRequest, ctx: Context) { return proxy(req, ctx); }
export async function DELETE(req: NextRequest, ctx: Context) { return proxy(req, ctx); }

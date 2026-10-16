import { resolveAccessIdentity } from './access-identity.mjs';
import { stagingSessionMe } from './security/auth-me.mjs';
import { changeInitialPassword } from './security/password-change.mjs';

// ICOP Cloudflare Workers Free staging API — bootstrap only.
// NO user records, passwords, impersonation, or business-data migration.
// Do not expose this Worker as a production API until dedicated auth/RBAC/MFA
// and domain modules are implemented and security-reviewed.
const SCHEMA = '0001_cf_free_staging_bootstrap';

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function checkDatabase(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') return false;
  try {
    const row = await env.DB.prepare(
      'SELECT version FROM migration_history WHERE version = ? LIMIT 1',
    ).bind(SCHEMA).first();
    return row?.version === SCHEMA;
  } catch {
    // Never reveal SQL, binding names, customer data, or errors publicly.
    return false;
  }
}

// Schema presence is NOT proof of a usable authentication or RBAC service.
// Never enable login just because users/audit tables were created.
async function identitySchemaPrepared(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') return false;
  try {
    const row = await env.DB.prepare(
      'SELECT version FROM migration_history WHERE version = ? LIMIT 1',
    ).bind('0002_cf_free_identity_audit_schema').first();
    return row?.version === '0002_cf_free_identity_audit_schema';
  } catch {
    return false;
  }
}

// Check only schema readiness; NEVER infer permission to authenticate from DDL.
async function authSecuritySchemaPrepared(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') return false;
  try {
    const row = await env.DB.prepare(
      'SELECT version FROM migration_history WHERE version = ? LIMIT 1',
    ).bind('0003_cf_free_auth_security_foundation').first();
    return row?.version === '0003_cf_free_auth_security_foundation';
  } catch {
    return false;
  }
}

const UNAVAILABLE = { code: 'MODULE_NOT_MIGRATED', message: 'Cloudflare staging: this module is not yet available.' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const healthy = path === '/health' && request.method === 'GET';
    const readiness = path === '/api/v1/system/readiness' && request.method === 'GET';
    if (healthy || readiness) {
      if (!await checkDatabase(env)) return reply(503, { status: 'unavailable', code: 'STAGING_DB_NOT_READY' });
      if (healthy) return reply(200, { status: 'ok', environment: 'staging', database: 'ready' });
      return reply(200, {
        status: 'bootstrap_only',
        environment: 'staging',
        database: 'ready',
        schema: {
          identity_audit_prepared: await identitySchemaPrepared(env),
          auth_security_prepared: await authSecuritySchemaPrepared(env),
        },
        capabilities: {
          authentication: false,
          mfa: false,
          tenant_rbac: false,
          crm: false,
          tender: false,
          pricing: false,
          quotation: false,
          document_ocr: false,
          background_jobs: false,
        },
      });
    }

    // Access identities can only perform a read-only onboarding check.
    // No app session is issued, and this is NOT a replacement for /auth/login.
    if (path === '/api/v1/auth/access-me' && request.method === 'GET') {
      if (!await identitySchemaPrepared(env)) {
        return reply(503, { code: 'STAGING_IDENTITY_SCHEMA_NOT_READY' });
      }
      const identity = await resolveAccessIdentity(request, env, ctx);
      if (!identity.ok) return reply(identity.status, { code: identity.code });
      return reply(identity.status, identity.body);
    }

    if (path === '/api/v1/auth/me' && request.method === 'GET') {
      const result=await stagingSessionMe(request,env,ctx);
      return reply(result.status,result.body);
    }


    // U01 staged initial-password-change. This is not /auth/login and MUST
    // remain unavailable until separate Access MFA, identity, first-factor
    // and password-change release gates are explicitly approved. Never
    // mint a session or accept an account/role from request JSON.
    if (path === '/api/v1/auth/initial-password-change') {
      if (request.method !== 'POST') return reply(405, {code:'METHOD_NOT_ALLOWED'});
      if (env?.AUTH_V2_ENABLED !== 'true' ||
          env?.ACCESS_IDENTITY_ENABLED !== 'true' ||
          env?.ACCESS_MFA_CONFIRMED !== 'true' ||
          env?.PASSWORD_FIRST_FACTOR_ENABLED !== 'true' ||
          env?.PASSWORD_CHANGE_ENABLED !== 'true')
        return reply(503, {code:'STAGING_AUTH_NOT_READY'});
      // Explicit same-origin anti-CSRF barrier for Access-cookie browsers.
      // CORS is not enabled. Keep this route staging-origin-only until a
      // separate reviewed frontend CSRF contract is available.
      if (request.headers.get('origin') !== url.origin ||
          (request.headers.get('sec-fetch-site') &&
           request.headers.get('sec-fetch-site') !== 'same-origin'))
        return reply(403, {code:'ORIGIN_DENIED'});
      if (!ctx?.access || ctx.access.aud !== env.ACCESS_AUD ||
          typeof ctx.access.getIdentity !== 'function')
        return reply(403, {code:'ACCESS_REQUIRED'});
      const mime = (request.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase();
      if (mime !== 'application/json')
        return reply(415, {code:'JSON_REQUIRED'});
      const length = Number(request.headers.get('content-length')||0);
      if (!Number.isFinite(length) || length>4096)
        return reply(413, {code:'REQUEST_TOO_LARGE'});
      let data;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length>4096)
          return reply(413, {code:'REQUEST_TOO_LARGE'});
        data=JSON.parse(raw);
      } catch {return reply(400, {code:'INVALID_JSON'});}
      if (!data || Array.isArray(data) || typeof data!=='object' ||
          typeof data.tenantCode!=='string' ||
          typeof data.currentPassword!=='string' ||
          typeof data.newPassword!=='string')
        return reply(400, {code:'AUTH_INVALID'});
      try {
        const outcome=await changeInitialPassword({
          ctx,db:env.DB,env,tenantCode:data.tenantCode,
          currentPassword:data.currentPassword,
          newPassword:data.newPassword,
          ip:request.headers.get('cf-connecting-ip')
        });
        if (outcome.ok) return reply(202, {
          status:'password_changed_mfa_enrollment_pending',
          applicationAuthenticated:false,
          mfaEnrollmentRequired:true,
          sessionIssued:false
        });
        const code=outcome.code||'STAGING_AUTH_NOT_READY';
        const status=code==='STAGING_AUTH_NOT_READY' || code==='STAGING_DB_NOT_READY' ||
          code==='STAGING_AUDIT_NOT_CONFIGURED'?503:
          code==='ACCESS_REQUIRED'?403:
          code==='PASSWORD_POLICY'?422:
          code==='PASSWORD_CHANGE_CONFLICT'?409:
          code==='AUTH_INVALID'?400:401;
        return reply(status,{code});
      } catch {return reply(503,{code:'STAGING_AUTH_NOT_READY'});}
    }

    // Explicit fail-closed response. No password processing or JWTs until the
    // auth migration is reviewed. Do not attach a fake admin to an empty DB.
    if (path === '/api/v1/auth/login' && request.method === 'POST') {
      return reply(503, { code: 'STAGING_AUTH_NOT_READY', message: 'Authentication is not yet migrated to Cloudflare staging.' });
    }
    if (path.startsWith('/api/v1/')) return reply(503, UNAVAILABLE);
    return reply(404, { code: 'NOT_FOUND' });
  },
};

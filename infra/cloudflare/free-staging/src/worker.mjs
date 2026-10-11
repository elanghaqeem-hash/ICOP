import { resolveAccessIdentity } from './access-identity.mjs';
import { stagingSessionMe } from './security/auth-me.mjs';

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

    // Explicit fail-closed response. No password processing or JWTs until the
    // auth migration is reviewed. Do not attach a fake admin to an empty DB.
    if (path === '/api/v1/auth/login' && request.method === 'POST') {
      return reply(503, { code: 'STAGING_AUTH_NOT_READY', message: 'Authentication is not yet migrated to Cloudflare staging.' });
    }
    if (path.startsWith('/api/v1/')) return reply(503, UNAVAILABLE);
    return reply(404, { code: 'NOT_FOUND' });
  },
};

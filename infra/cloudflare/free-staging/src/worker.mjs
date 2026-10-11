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

const UNAVAILABLE = { code: 'MODULE_NOT_MIGRATED', message: 'Cloudflare staging: this module is not yet available.' };

export default {
  async fetch(request, env) {
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

    // Explicit fail-closed response. No password processing or JWTs until the
    // auth migration is reviewed. Do not attach a fake admin to an empty DB.
    if (path === '/api/v1/auth/login' && request.method === 'POST') {
      return reply(503, { code: 'STAGING_AUTH_NOT_READY', message: 'Authentication is not yet migrated to Cloudflare staging.' });
    }
    if (path.startsWith('/api/v1/')) return reply(503, UNAVAILABLE);
    return reply(404, { code: 'NOT_FOUND' });
  },
};

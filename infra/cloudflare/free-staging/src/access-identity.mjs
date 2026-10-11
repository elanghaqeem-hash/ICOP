/**
 * Phase 3A: Cloudflare Access identity gate, NOT ICOP password authentication.
 * Only trust ctx.access, populated by the Workers runtime after Access verified
 * the request. NEVER trust email/role in a user-supplied header or JWT body.
 *
 * Cloudflare Workers Access docs:
 * https://developers.cloudflare.com/workers/configuration/cloudflare-access/
 */
const ROLES = new Set([
  'super_admin', 'company_admin', 'director', 'vp_head', 'sales_manager',
  'account_manager', 'presales_engineer', 'solution_architect',
  'pricing_finance', 'legal', 'tender_officer', 'procurement_officer',
  'project_manager', 'delivery_engineer', 'soc_operations',
  'product_manager', 'customer_support', 'auditor',
  'partner_user', 'customer_user',
]);

const deny = (status, code) => ({ ok: false, status, code });

export async function resolveAccessIdentity(request, env, ctx) {
  // Explicit default-deny feature gate: staging remains safe before Access
  // and the MFA policy are configured. No ambient shared account credentials.
  if (env?.ACCESS_IDENTITY_ENABLED !== 'true' || !env?.ACCESS_AUD ||
      typeof env.ACCESS_AUD !== 'string') {
    return deny(503, 'STAGING_ACCESS_NOT_CONFIGURED');
  }
  if (!ctx?.access || typeof ctx.access.getIdentity !== 'function') {
    return deny(403, 'ACCESS_REQUIRED');
  }
  if (ctx.access.aud !== env.ACCESS_AUD) return deny(403, 'ACCESS_REQUIRED');
  const tenantCode = request.headers.get('x-icop-tenant')?.trim();
  if (!tenantCode || !/^[A-Z0-9_-]{2,32}$/.test(tenantCode)) {
    return deny(400, 'TENANT_REQUIRED');
  }

  let identity;
  try {
    identity = await ctx.access.getIdentity();
  } catch {
    return deny(403, 'ACCESS_REQUIRED');
  }
  const email = identity?.email?.trim().toLowerCase();
  if (!email || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return deny(403, 'ACCESS_REQUIRED');
  }
  if (!env.DB || typeof env.DB.prepare !== 'function') {
    return deny(503, 'STAGING_DB_NOT_READY');
  }

  // The identity provider proves the email, never the tenant, role or active
  // status. All of those must be resolved from the authoritative D1 mapping.
  let user;
  try {
    user = await env.DB.prepare(`
      SELECT u.id, u.tenant_id, u.email_normalized, u.full_name, u.role,
             u.is_active, u.force_password_change, u.mfa_enabled, t.code
      FROM users u INNER JOIN tenants t ON t.id = u.tenant_id
      WHERE t.code = ? AND u.email_normalized = ? LIMIT 1
    `).bind(tenantCode, email).first();
  } catch {
    return deny(503, 'STAGING_DB_NOT_READY');
  }
  if (!user || user.is_active !== 1 || !ROLES.has(user.role)) {
    // Never reveal whether a tenant exists or an account is disabled.
    return deny(403, 'ACCESS_MEMBERSHIP_DENIED');
  }

  // Access identity is NOT proof of local password-change or MFA completion.
  // Stage 3B must implement app-level MFA/renewal or formal equivalence checks.
  // Until then no bearer JWT, session cookies, or business permissions.
  try {
    const ip = (request.headers.get('cf-connecting-ip') || '').slice(0, 64);
    await env.DB.prepare(`
      INSERT INTO audit_events
        (tenant_id, actor_id, action, entity_type, entity_id, ip)
      VALUES (?, ?, 'auth.access_identity_checked', 'user', ?, ?)
    `).bind(user.tenant_id, user.id, user.id, ip).run();
  } catch {
    return deny(503, 'STAGING_AUDIT_UNAVAILABLE');
  }
  return {
    ok: true, status: 202,
    body: {
      status: 'identity_verified_application_auth_pending',
      identityProvider: 'cloudflare_access',
      tenant: { code: user.code },
      user: {
        id: user.id,
        fullName: user.full_name,
        role: user.role,
        forcePasswordChange: user.force_password_change === 1,
      },
      accessAuthenticated: true,
      applicationAuthenticated: false,
      mfaVerified: false,
      permissions: [],
    },
  };
}

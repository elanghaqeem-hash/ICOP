// Cloudflare-native staging security policy, translated from
// apps/api/src/modules/auth/policy.ts and apps/api/src/lib/rbac.ts.
// It does not grant access by itself. All unported endpoints remain disabled.
export const ROLES = Object.freeze([
  'super_admin', 'company_admin', 'director', 'vp_head', 'sales_manager',
  'account_manager', 'presales_engineer', 'solution_architect',
  'pricing_finance', 'legal', 'tender_officer', 'procurement_officer',
  'project_manager', 'delivery_engineer', 'soc_operations', 'product_manager',
  'customer_support', 'auditor', 'partner_user', 'customer_user',
]);

export const PRIVILEGED_MFA_ROLES = Object.freeze([
  'super_admin', 'company_admin', 'director', 'vp_head', 'sales_manager',
  'pricing_finance', 'legal', 'tender_officer',
]);

// High-risk subset sourced from Fastify permissions; deliberately deny all
// unlisted permission names instead of assuming implicit superadmin privilege.
// Full parity with source RBAC must be signed off before access is enabled.
const ALLOWED = Object.freeze({
  'auth.me': ROLES,
  'user.manage': ['company_admin', 'super_admin'],
  'audit.read': ['auditor', 'company_admin', 'super_admin', 'director'],
  'approval.decide': ['sales_manager', 'vp_head', 'director'],
  'policy.activate': ['director', 'company_admin'],
  'portal.access': ['customer_user'],
  'integration.admin': ['company_admin', 'super_admin'],
  'pricing.view_cost': [
    'presales_engineer', 'solution_architect', 'pricing_finance', 'sales_manager',
    'vp_head', 'director', 'auditor', 'company_admin', 'super_admin',
  ],
});

export function mustUseMfa(role, enrolled = false) {
  return Boolean(enrolled) || PRIVILEGED_MFA_ROLES.includes(role);
}

// Deliberately defaults to deny. The caller must verify the session,
// token_version and tenant from the database; client-provided role is untrusted.
export function authorizationGate({actor, resourceTenantId, permission}) {
  if (!actor || !ROLES.includes(actor.role) ||
      !actor.id || !actor.tenantId || !resourceTenantId ||
      actor.tenantId !== resourceTenantId) return 'TENANT_DENIED';
  if (!actor.isActive) return 'INACTIVE_ACCOUNT';
  if (actor.forcePasswordChange) return 'PASSWORD_CHANGE_REQUIRED';
  // A stale or invalid session must never claim MFA success after an account
  // unenrolls MFA. Enrollment + verified session are both required when the
  // role has mandatory MFA; contradictory MFA state is always rejected.
  if (actor.mfaVerified && !actor.mfaEnabled) return 'MFA_REQUIRED';
  if (mustUseMfa(actor.role, actor.mfaEnabled) &&
      (!actor.mfaEnabled || !actor.mfaVerified)) return 'MFA_REQUIRED';
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, permission) ||
      !ALLOWED[permission].includes(actor.role)) return 'PERMISSION_DENIED';
  return 'ALLOW';
}

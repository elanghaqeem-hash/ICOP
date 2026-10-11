/**
 * UAT U02 + U24 staging-only MFA reset policy.
 * Source of truth: Phase 6 Fastify auth reset route and UAT Pack.
 * This is a PURE preflight decision; it does not read D1, mutate MFA,
 * issue tokens or install any HTTP endpoints. Verified actor/target records
 * must be supplied only by a future authenticated backend handler.
 */
import { authorizationGate } from './policy.mjs';

export function planMfaReset({ actor, target, reason }) {
  const deny = (code) => ({ allowed: false, code });

  // The caller MUST fetch actor and target from server-side identity/session
  // stores. Browser-supplied "role", "tenantId" or "mfaVerified" is not trusted.
  if (!actor || !target || typeof target.tenantId !== 'string' ||
      typeof target.id !== 'string' || !target.id) return deny('TARGET_NOT_FOUND');

  const decision = authorizationGate({
    actor, resourceTenantId: target.tenantId, permission: 'user.manage',
  });
  if (decision !== 'ALLOW') return deny(decision);

  // Explicit segregation of duties: even tenant Superadmin may not reset
  // their own MFA using this administrative recovery path.
  if (actor.id === target.id) return deny('SELF_RESET_FORBIDDEN');
  if (target.isActive !== true) return deny('TARGET_INACTIVE');

  const cleanReason = typeof reason === 'string' ? reason.trim() : '';
  if (cleanReason.length < 10 || cleanReason.length > 500) {
    return deny('REASON_REQUIRED');
  }

  // token_version is the existing Phase 6 revocation mechanism. Target
  // changes MUST be executed atomically with session revocation + audit.
  if (!Number.isSafeInteger(target.tokenVersion) ||
      target.tokenVersion < 0 || target.tokenVersion >= Number.MAX_SAFE_INTEGER) {
    return deny('TOKEN_VERSION_INVALID');
  }

  return {
    allowed: true,
    // Pure instruction only, NEVER an authorization or a completed reset.
    plan: {
      tenantId: target.tenantId,
      actorId: actor.id,
      targetId: target.id,
      nextTokenVersion: target.tokenVersion + 1,
      revokeAllSessions: true,
      clearMfaEnrollment: true,
      requireReenrollment: true,
      auditAction: 'auth.mfa_reset',
      reason: cleanReason,
    },
  };
}

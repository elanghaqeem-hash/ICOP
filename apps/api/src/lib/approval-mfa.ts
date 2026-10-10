import { AppError } from './errors.js';
import type { AuthUser } from './context.js';
import { mfaChallengeRequired } from '../modules/auth/policy.js';

export const APPROVAL_STEP_UP_SECONDS = 300;

/**
 * Fresh authenticator challenge on every critical decision in production.
 * The backend enforces this independently of the Next/browser BFF.
 * Dev fixtures without required MFA remain compatible.
 */
export function requireFreshApprovalMfa(
  user: AuthUser,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!mfaChallengeRequired(user.role, user.mfaEnrolled === true)) return;
  if (!user.mfaVerified || typeof user.mfaAt !== 'number' ||
      !Number.isFinite(user.mfaAt) || user.mfaAt > nowSeconds ||
      nowSeconds - user.mfaAt >= APPROVAL_STEP_UP_SECONDS) {
    throw new AppError(403, 'MFA_STEP_UP_REQUIRED',
      'Konfirmasi kode autentikator terbaru sebelum memutus approval');
  }
}

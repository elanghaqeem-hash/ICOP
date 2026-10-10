import { config } from '../../config.js';

export const PRIVILEGED_MFA_ROLES = new Set([
  'super_admin', 'company_admin', 'director', 'vp_head', 'sales_manager',
  'pricing_finance', 'legal', 'tender_officer',
]);

// Production fail-closed for privileged roles by default. Tests and development
// can explicitly enable the policy to exercise enrollment and challenge flows.
export function mustUseMfa(role: string): boolean {
  const policy = process.env.MFA_POLICY ?? (config.nodeEnv === 'production' ? 'privileged' : 'off');
  if (policy === 'all') return true;
  if (policy === 'privileged') return PRIVILEGED_MFA_ROLES.has(role);
  if (policy === 'off' && config.nodeEnv !== 'production') return false;
  // Invalid or disabled policy in production must never disable MFA.
  return config.nodeEnv === 'production' ? PRIVILEGED_MFA_ROLES.has(role) : false;
}

export function mfaChallengeRequired(role: string, enrolled: boolean) {
  return enrolled || mustUseMfa(role);
}

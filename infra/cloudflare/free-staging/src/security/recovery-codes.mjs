/**
 * Cloudflare Free / WebCrypto recovery-code primitive, staging-only.
 * Adapted to the source Phase 6 UAT U01 requirement: precisely ten
 * one-time recovery codes, displayed once after successful MFA enrollment.
 *
 * This file NEVER installs an auth route, issues an ICOP session, persists a
 * code, or provisions a user. Only hashes may be persisted by a future
 * transactional+audited enrollment/consumption endpoint.
 */
const NUMBER_OF_CODES = 10;
const RE_HEX_KEY = /^[a-f0-9]{64}$/i;
const RE_ID = /^[a-zA-Z0-9_-]{2,80}$/;
const RE_CODE = /^[0-9A-F]{8}(?:-[0-9A-F]{8}){3}$/;

function secretBytes(secret) {
  if (typeof secret !== 'string' || !RE_HEX_KEY.test(secret)) {
    throw new Error('MFA_RECOVERY_KEY_NOT_CONFIGURED');
  }
  return Uint8Array.from(secret.match(/../g), part => parseInt(part, 16));
}

function normalizeCode(code) {
  if (typeof code !== 'string' || !RE_CODE.test(code)) {
    throw new Error('MFA_RECOVERY_CODE_INVALID');
  }
  return code.replaceAll('-', '');
}

export async function hashRecoveryCode({ secret, tenantId, userId, code }) {
  if (typeof tenantId !== 'string' || !RE_ID.test(tenantId) ||
      typeof userId !== 'string' || !RE_ID.test(userId)) {
    throw new Error('MFA_RECOVERY_SUBJECT_INVALID');
  }
  const key = await crypto.subtle.importKey('raw', secretBytes(secret), {
    name: 'HMAC', hash: 'SHA-256'
  }, false, ['sign']);
  // Explicit domain separation + tenant/user scoping prevents a digest from
  // identifying the same code across two accounts or different products.
  const data = new TextEncoder().encode(
    'icop-staging:mfa-recovery:v1\n' + tenantId + '\n' + userId + '\n' + normalizeCode(code)
  );
  const digest = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Output codes MUST be shown once and never logged or committed. Caller MUST
 * persist only hashes after confirmed MFA enrollment and an append-only audit.
 * Key is a Worker secret independent from ACCESS_AUDIT_HMAC_KEY.
 */
export async function createRecoveryCodes({ secret, tenantId, userId }) {
  // Fail before requesting entropy if configuration is missing or invalid.
  secretBytes(secret);
  if (!RE_ID.test(tenantId ?? '') || !RE_ID.test(userId ?? '')) {
    throw new Error('MFA_RECOVERY_SUBJECT_INVALID');
  }
  const codes = [];
  const hashes = [];
  for (let i = 0; i < NUMBER_OF_CODES; i++) {
    const random = new Uint8Array(16); // 128 unpredictable bits per code
    crypto.getRandomValues(random);
    const hex = Array.from(random,
      byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    const code = hex.match(/.{8}/g).join('-');
    codes.push(code);
    hashes.push(await hashRecoveryCode({ secret, tenantId, userId, code }));
  }
  if (new Set(hashes).size !== NUMBER_OF_CODES) {
    throw new Error('MFA_RECOVERY_ENTROPY_FAILURE');
  }
  return { codes, hashes };
}

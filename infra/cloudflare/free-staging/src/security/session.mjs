/**
 * ICOP staging: Workers WebCrypto session primitives.
 * Not used by live endpoints until Access/MFA/provisioning gates are passed.
 *
 * Raw tokens never go to D1. The DB receives only a keyed HMAC digest.
 * Keys must be provisioned using Worker secrets, NOT committed to this repo.
 */
import { authorizationGate, mustUseMfa } from './policy.mjs';

const hex = (bytes) => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const looksLikeSession = (token) => typeof token === 'string' && /^s1_[a-f0-9]{64}$/.test(token);
const toBytes = (s) => new Uint8Array(s.match(/../g).map(v=>parseInt(v,16)));
function validKey(keyHex) {
  return typeof keyHex === 'string' && /^[a-f0-9]{64,128}$/i.test(keyHex)
    && keyHex.length % 2 === 0;
}
export function newSessionToken() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('CSPRNG_UNAVAILABLE');
  return 's1_' + hex(crypto.getRandomValues(new Uint8Array(32)));
}
export async function hashSessionToken(token, keyHex) {
  if (!looksLikeSession(token) || !validKey(keyHex)) return null;
  if (!globalThis.crypto?.subtle) return null;
  const signingKey = await crypto.subtle.importKey('raw',toBytes(keyHex),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest = await crypto.subtle.sign('HMAC',signingKey,new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

/**
 * Permission-gated session lookup always uses authoritative joined user state
 * from D1, never browser-supplied role, MFA, tenant, or token version.
 * Sessions must have been generated only by a separately reviewed login flow.
 */
export async function verifySession(db, token, keyHex, tenantId, permission, nowSec=Math.floor(Date.now()/1000)) {
  if (!db || typeof db.prepare !== 'function' ||
      typeof tenantId !== 'string' || !tenantId ||
      typeof permission !== 'string' || !permission ||
      !Number.isSafeInteger(nowSec) || nowSec < 0) {
    return {ok:false,code:'SESSION_INVALID'};
  }
  const digest = await hashSessionToken(token,keyHex);
  if (!digest) return {ok:false,code:'SESSION_INVALID'};
  let row;
  try {
    row = await db.prepare(`
      SELECT s.tenant_id, s.user_id, s.token_version AS session_version,
             s.mfa_verified, s.issued_at, s.expires_at, s.revoked_at,
             u.token_version AS user_version, u.role, u.is_active,
             u.force_password_change, u.mfa_enabled
      FROM auth_sessions s
      JOIN users u ON u.tenant_id=s.tenant_id AND u.id=s.user_id
      WHERE s.session_id_hash=? LIMIT 1
    `).bind(digest).first();
  } catch {
    return {ok:false,code:'SESSION_DB_UNAVAILABLE'};
  }
  if (!row || row.tenant_id !== tenantId || row.revoked_at !== null &&
      row.revoked_at !== undefined ||
      !Number.isSafeInteger(Number(row.issued_at)) ||
      !Number.isSafeInteger(Number(row.expires_at)) ||
      nowSec < Number(row.issued_at) || nowSec >= Number(row.expires_at) ||
      Number(row.session_version) !== Number(row.user_version)) {
    return {ok:false,code:'SESSION_INVALID'};
  }
  const actor = {
    id:row.user_id,tenantId:row.tenant_id,role:row.role,
    isActive:row.is_active===1,
    forcePasswordChange:row.force_password_change===1,
    mfaEnabled:row.mfa_enabled===1,mfaVerified:row.mfa_verified===1,
  };
  const decision = authorizationGate({actor,resourceTenantId:tenantId,permission});
  if (decision !== 'ALLOW') return {ok:false,code:decision};
  return {ok:true,actor:{id:actor.id,tenantId:actor.tenantId,role:actor.role,
    mfaVerified:actor.mfaVerified}};
}

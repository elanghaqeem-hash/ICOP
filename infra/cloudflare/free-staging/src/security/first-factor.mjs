/**
 * Cloudflare D1 staging password first-factor.
 * Based on Phase 6 auth/routes.ts and UAT U01/U24. This module does NOT mint
 * a session or verify TOTP. A trusted edge Access identity must already exist;
 * a browser-provided email/role cannot select an account.
 */
import { verifyNewPassword } from './credentials.mjs';

const validTenant = value => typeof value === 'string' && /^[A-Z0-9_-]{2,32}$/.test(value);
const deny = code => ({ ok: false, code });
const auditIp = async (ip, keyHex) => {
  if (!/^[a-f0-9]{64}$/i.test(keyHex ?? '') ||
      typeof ip !== 'string' || !/^[0-9a-fA-F:.]{3,64}$/.test(ip)) return null;
  const keyBytes = Uint8Array.from(keyHex.match(/../g), h => parseInt(h,16));
  const key = await crypto.subtle.importKey('raw',keyBytes,
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const data = new TextEncoder().encode('icop:d1:audit:ip:v1:'+ip);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC',key,data));
  return 'hmac-sha256:'+Array.from(mac,h=>h.toString(16).padStart(2,'0')).join('');
};
function parseLock(value) {
  if (value == null || value === '') return 0;
  if (typeof value !== 'string') return Infinity;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? value.replace(' ','T')+'Z' : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Infinity;
}

/**
 * @param {object} args
 * @param {object} args.ctx Only trusted Workers ctx.access; no forged headers
 * @param {object} args.db D1 binding
 * @param {string} args.tenantCode Explicit tenant selector, resolved in D1
 * @param {string} args.password Current password, never logged or persisted
 * @param {object} args.env Secret / MFA release gates
 * @param {string} args.ip Trusted Cloudflare connecting IP, not X-Forwarded-For
 * @returns {object} No JWT, session, TOTP secret or bearer credentials
 */
export async function verifyStagingFirstFactor({ctx,db,tenantCode,password,env,ip,now=Date.now()}) {
  if (env?.AUTH_V2_ENABLED !== 'true' ||
      env?.ACCESS_IDENTITY_ENABLED !== 'true' ||
      env?.ACCESS_MFA_CONFIRMED !== 'true' ||
      env?.PASSWORD_FIRST_FACTOR_ENABLED !== 'true')
    return deny('STAGING_AUTH_NOT_READY');
  if (!ctx?.access || ctx.access.aud !== env.ACCESS_AUD ||
      typeof ctx.access.getIdentity !== 'function')
    return deny('ACCESS_REQUIRED');
  if (!db?.prepare || !db?.batch ||
      !validTenant(tenantCode) ||
      typeof password !== 'string' || !password || password.length > 128 ||
      !Number.isSafeInteger(now) || now <= 0)
    return deny('AUTH_INVALID');
  const digestIp = await auditIp(ip,env.ACCESS_AUDIT_HMAC_KEY);
  if (!digestIp) return deny('STAGING_AUDIT_NOT_CONFIGURED');

  let email;
  try {
    const identity = await ctx.access.getIdentity();
    email = identity?.email?.trim().toLowerCase();
  } catch { return deny('ACCESS_REQUIRED'); }
  if (typeof email !== 'string' || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return deny('ACCESS_REQUIRED');

  let user;
  try {
    user = await db.prepare(`
      SELECT u.id,u.tenant_id,u.email_normalized,u.password_hash,u.role,
             u.is_active,u.force_password_change,u.mfa_enabled,
             u.failed_logins,u.locked_until,u.token_version
      FROM users u INNER JOIN tenants t ON t.id=u.tenant_id
      WHERE t.code=? AND u.email_normalized=? LIMIT 1
    `).bind(tenantCode,email).first();
  } catch { return deny('STAGING_DB_NOT_READY'); }
  if (!user || user.is_active !== 1 || user.email_normalized !== email)
    return deny('INVALID_CREDENTIALS');

  if (parseLock(user.locked_until) > now) return deny('ACCOUNT_LOCKED');

  let valid = false;
  try { valid = await verifyNewPassword(password,user.password_hash); }
  catch { return deny('STAGING_AUTH_NOT_READY'); }
  const statement = (sql,...values) => db.prepare(sql).bind(...values);
  const seconds = Math.floor(now/1000);
  const failAudit = statement(`
    INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip)
    VALUES (?,?,'auth.login_failed','user',?,?)
  `,user.tenant_id,user.id,user.id,digestIp);
  if (!valid) {
    try {
      const result=await db.batch([
        statement(`
          UPDATE users SET failed_logins=failed_logins+1,
            locked_until=CASE WHEN failed_logins+1>=5
              THEN datetime(?,'unixepoch','+15 minutes') ELSE NULL END
          WHERE tenant_id=? AND id=? AND is_active=1
        `,seconds,user.tenant_id,user.id),
        failAudit,
      ]);
      if (!Array.isArray(result) || result.length !== 2 ||
          result.some(x=>x?.success!==true || Number(x.meta?.changes)!==1))
        return deny('STAGING_DB_NOT_READY');
    } catch { return deny('STAGING_DB_NOT_READY'); }
    return deny('INVALID_CREDENTIALS');
  }
  // Password first-factor is NOT an application login. A TOTP verification and
  // replay-safe D1 session issuance must be completed before authentication.
  // Every verified first-factor event is audited, including first-login
  // password changes and MFA enrollment; neither grants a session.
  const pending = user.force_password_change !== 0
    ? 'PASSWORD_CHANGE_REQUIRED'
    : user.mfa_enabled !== 1 ? 'MFA_ENROLLMENT_REQUIRED' : null;
  const event = pending === 'PASSWORD_CHANGE_REQUIRED'
    ? 'auth.password_verified_change_pending'
    : pending === 'MFA_ENROLLMENT_REQUIRED'
      ? 'auth.password_verified_enrollment_pending'
      : 'auth.password_verified_mfa_pending';
  try {
    const result=await db.batch([
      statement(`UPDATE users SET failed_logins=0, locked_until=NULL
        WHERE tenant_id=? AND id=? AND is_active=1`,user.tenant_id,user.id),
      statement(`INSERT INTO audit_events
        (tenant_id,actor_id,action,entity_type,entity_id,ip)
        VALUES (?,?,?,?,?,?)`,
        user.tenant_id,user.id,event,'user',user.id,digestIp),
    ]);
    if (!Array.isArray(result) || result.length !== 2 ||
        result.some(x=>x?.success!==true || Number(x.meta?.changes)!==1))
      return deny('STAGING_DB_NOT_READY');
  } catch { return deny('STAGING_DB_NOT_READY'); }
  if (pending) return deny(pending);
  return {ok:true,tenantId:user.tenant_id,userId:user.id,
    mfaRequired:true,sessionIssued:false};
}

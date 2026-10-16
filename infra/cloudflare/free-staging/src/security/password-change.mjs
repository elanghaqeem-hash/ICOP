/**
 * Phase 3C / UAT U01-U24 — server-only initial password replacement.
 * A caller must use verified Cloudflare Workers ctx.access and the real D1
 * binding. NEVER enable as a public endpoint without Access/MFA challenge UAT.
 * This helper does not issue tokens, cookies, identity claims or MFA secrets.
 */
import { verifyStagingFirstFactor } from './first-factor.mjs';
import { hashNewPassword, verifyNewPassword } from './credentials.mjs';

const deny = code => ({ok:false,code});
const tenantRe = /^[A-Z0-9_-]{2,32}$/;
const userRe = /^[a-zA-Z0-9_-]{2,128}$/;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const keyRe = /^[a-f0-9]{64}$/i;

async function auditIp(ip, keyHex) {
  if(typeof ip!=='string' || !/^[0-9a-fA-F:.]{3,64}$/.test(ip) ||
     typeof keyHex!=='string' || !keyRe.test(keyHex)) return null;
  const key=await crypto.subtle.importKey('raw',
    Uint8Array.from(keyHex.match(/../g),v=>parseInt(v,16)),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=await crypto.subtle.sign('HMAC',key,
    new TextEncoder().encode('icop:d1:audit:ip:v1:'+ip));
  return 'hmac-sha256:'+Array.from(new Uint8Array(signed),
    v=>v.toString(16).padStart(2,'0')).join('');
}
function safeBatch(results,size) {
  return Array.isArray(results) && results.length===size &&
    results.every(x=>x?.success===true && Number.isSafeInteger(Number(x.meta?.changes)));
}

/**
 * Initial password change is available only after verifying the real old
 * password and Access identity through the same guarded first-factor flow.
 * The newly derived hash is salted PBKDF2-SHA256 (600,000 iterations).
 *
 * The UPDATE has a compare-and-swap predicate; a racing password/version
 * change cannot authorize a second update. The append-only audit insertion
 * is conditional on the new persisted hash/version. D1 batch is atomic when
 * SQL fails, so an audit error rolls back password/session writes.
 */
export async function changeInitialPassword({
  ctx,db,tenantCode,currentPassword,newPassword,env,ip,now=Date.now()
}) {
  if(env?.AUTH_V2_ENABLED!=='true' ||
     env?.ACCESS_IDENTITY_ENABLED!=='true' ||
     env?.ACCESS_MFA_CONFIRMED!=='true' ||
     env?.PASSWORD_FIRST_FACTOR_ENABLED!=='true' ||
     env?.PASSWORD_CHANGE_ENABLED!=='true')
    return deny('STAGING_AUTH_NOT_READY');
  if(!ctx?.access || ctx.access.aud!==env.ACCESS_AUD ||
     typeof ctx.access.getIdentity!=='function') return deny('ACCESS_REQUIRED');
  if(!db?.prepare || !db?.batch || !tenantRe.test(tenantCode??'') ||
     typeof currentPassword!=='string' || currentPassword.length===0 ||
     currentPassword.length>128 || typeof newPassword!=='string' ||
     !Number.isSafeInteger(now) || now<=0) return deny('AUTH_INVALID');
  if(!keyRe.test(env.ACCESS_AUDIT_HMAC_KEY??''))
    return deny('STAGING_AUDIT_NOT_CONFIGURED');

  // The existing first-factor helper performs lockout accounting and audit
  // on wrong passwords. Do not weaken or duplicate its policy.
  const factor=await verifyStagingFirstFactor({
    ctx,db,tenantCode,password:currentPassword,env,ip,now
  });
  if(factor?.code!=='PASSWORD_CHANGE_REQUIRED')
    return deny(factor?.code||'INVALID_CREDENTIALS');

  let email,user;
  try {
    const identity=await ctx.access.getIdentity();
    email=identity?.email?.trim().toLowerCase();
    if(typeof email!=='string'||email.length>254||!emailRe.test(email))
      return deny('ACCESS_REQUIRED');
    user=await db.prepare(`
      SELECT u.id,u.tenant_id,u.email_normalized,u.password_hash,
             u.force_password_change,u.is_active,u.token_version
      FROM users u INNER JOIN tenants t ON t.id=u.tenant_id
      WHERE t.code=? AND u.email_normalized=? LIMIT 1
    `).bind(tenantCode,email).first();
  } catch {return deny('STAGING_DB_NOT_READY');}
  if(!user || !userRe.test(user.id??'') || !userRe.test(user.tenant_id??'') ||
     user.email_normalized!==email || user.is_active!==1 ||
     user.force_password_change!==1 ||
     !Number.isSafeInteger(Number(user.token_version)) ||
     Number(user.token_version)<0 || Number(user.token_version)>=2147483647)
    return deny('PASSWORD_CHANGE_NOT_ALLOWED');

  // Re-verify against the freshest password hash; a concurrent reset
  // invalidates this operation rather than reusing stale first-factor proof.
  try {
    if(!await verifyNewPassword(currentPassword,user.password_hash))
      return deny('INVALID_CREDENTIALS');
    if(await verifyNewPassword(newPassword,user.password_hash))
      return deny('PASSWORD_REUSE_DENIED');
  } catch {return deny('STAGING_AUTH_NOT_READY');}

  let nextHash,ipHash;
  try {
    nextHash=await hashNewPassword(newPassword);
    ipHash=await auditIp(ip,env.ACCESS_AUDIT_HMAC_KEY);
  } catch {return deny('PASSWORD_POLICY');}
  if(!ipHash) return deny('STAGING_AUDIT_NOT_CONFIGURED');
  const nextVersion=Number(user.token_version)+1;
  const seconds=Math.floor(now/1000);
  const stmt=(sql,...values)=>db.prepare(sql).bind(...values);
  const update=stmt(`
    UPDATE users
       SET password_hash=?,force_password_change=0,token_version=?,
           failed_logins=0,locked_until=NULL,
           mfa_pending_secret_enc=NULL,mfa_pending_expires_at=NULL,
           updated_at=datetime(?,'unixepoch')
     WHERE tenant_id=? AND id=? AND email_normalized=? AND is_active=1
       AND force_password_change=1 AND password_hash=? AND token_version=?
  `,nextHash,nextVersion,seconds,user.tenant_id,user.id,email,
    user.password_hash,Number(user.token_version));
  const revoke=stmt(`
    UPDATE auth_sessions SET revoked_at=?
     WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL
  `,seconds,user.tenant_id,user.id);
  const audit=stmt(`
    INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip)
    SELECT u.tenant_id,u.id,'auth.initial_password_changed','user',u.id,?
      FROM users u WHERE u.tenant_id=? AND u.id=? AND u.password_hash=?
       AND u.token_version=? AND u.force_password_change=0 AND u.is_active=1
  `,ipHash,user.tenant_id,user.id,nextHash,nextVersion);
  try {
    const result=await db.batch([update,revoke,audit]);
    if(!safeBatch(result,3) ||
       Number(result[0].meta.changes)!==1 ||
       Number(result[2].meta.changes)!==1)
      return deny('PASSWORD_CHANGE_CONFLICT');
  } catch{return deny('STAGING_DB_NOT_READY');}

  return {ok:true,passwordChanged:true,forceMfaEnrollment:true,
    sessionIssued:false,sessionsInvalidated:true};
}

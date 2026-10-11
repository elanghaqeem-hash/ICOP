/**
 * Read-only signed-in user session check for Cloudflare D1 staging.
 * Route is disabled unless approved AUTH_V2_ENABLED and MFA gates are set.
 * Access is NOT app authorization: the authoritative D1 session, tenant and
 * user role are checked independently; no login/session creation here.
 */
import { verifySession } from './session.mjs';
const deny=(status,code)=>({status,body:{code}});
const COOKIE='__Host-icop-staging-session';
function getCookie(request) {
  const raw=request.headers.get('cookie')||'';
  for(const part of raw.split(';')) {
    const i=part.indexOf('=');
    if(i>0 && part.slice(0,i).trim()===COOKIE) return part.slice(i+1).trim();
  }
  return null;
}
export async function stagingSessionMe(request,env,ctx) {
  if(env?.AUTH_V2_ENABLED!=='true' || env?.ACCESS_IDENTITY_ENABLED!=='true' ||
     env?.ACCESS_MFA_CONFIRMED!=='true')return deny(503,'STAGING_AUTH_NOT_READY');
  if(!ctx?.access||ctx.access.aud!==env.ACCESS_AUD||
     typeof ctx.access.getIdentity!=='function')return deny(403,'ACCESS_REQUIRED');
  if(!env.DB?.prepare||typeof env.SESSION_HMAC_KEY!=='string')
    return deny(503,'STAGING_AUTH_NOT_READY');
  const tenantId=request.headers.get('x-icop-tenant');
  if(!/^[a-zA-Z0-9_-]{2,128}$/.test(tenantId??''))return deny(400,'TENANT_REQUIRED');
  const token=getCookie(request);
  if(!token)return deny(401,'SESSION_REQUIRED');
  const verified=await verifySession(env.DB,token,env.SESSION_HMAC_KEY,tenantId,'auth.me');
  if(!verified.ok)return deny(401,'SESSION_INVALID');
  // Session authentication does not imply that the currently signed-in
  // Cloudflare Access identity matches the principal that owns the session.
  // Bind both factors to the same identity to prevent session sharing.
  let identity,user;
  try {
    identity=await ctx.access.getIdentity();
    const email=identity?.email?.trim().toLowerCase();
    if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return deny(403,'ACCESS_REQUIRED');
    user=await env.DB.prepare('SELECT email_normalized FROM users WHERE tenant_id=? AND id=? AND is_active=1 LIMIT 1')
      .bind(tenantId,verified.actor.id).first();
    if(!user||user.email_normalized!==email)
      return deny(403,'IDENTITY_SESSION_MISMATCH');
  } catch {return deny(503,'STAGING_DB_NOT_READY');}
  return {status:200,body:{
    user:{id:verified.actor.id,tenantId,role:verified.actor.role},
    mfaVerified:true,applicationAuthenticated:true
  }};
}

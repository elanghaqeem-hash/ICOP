/**
 * Phase 3C staging: issue and resolve short-lived MFA challenges.
 *
 * Browser receives only a random challenge handle after password first-factor.
 * D1 receives an HMAC digest scoped to tenant/user/purpose; no raw bearer,
 * email or password is written to D1 or audit. Verification requires the
 * current Cloudflare Access principal AND authoritative D1 user mapping.
 *
 * Challenge validation is read-only. A future reviewed TOTP completion
 * handler must atomically consume the challenge WITH verified MFA/audit.
 * This module cannot authenticate a user or create a session by itself.
 */
import {verifyStagingFirstFactor} from './first-factor.mjs';
const deny=code=>({ok:false,code});
const keyRe=/^[a-f0-9]{64}$/i;
const tokenRe=/^m1_[a-f0-9]{64}$/;
const tenantRe=/^[A-Z0-9_-]{2,32}$/;
const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const idRe=/^[a-zA-Z0-9_-]{2,128}$/;
const MAX_LIFETIME=300;

function securityReady(env) {
  return env?.AUTH_V2_ENABLED==='true' &&
    env?.ACCESS_IDENTITY_ENABLED==='true' &&
    env?.ACCESS_MFA_CONFIRMED==='true' &&
    env?.PASSWORD_FIRST_FACTOR_ENABLED==='true' &&
    env?.MFA_CHALLENGE_ENABLED==='true';
}
function accessReady(ctx,env) {
  return Boolean(ctx?.access && ctx.access.aud===env.ACCESS_AUD &&
    typeof ctx.access.getIdentity==='function');
}
function keyBytes(hex) {
  if(typeof hex!=='string'||!keyRe.test(hex))
    throw Error('AUTH_CHALLENGE_KEY_NOT_CONFIGURED');
  return Uint8Array.from(hex.match(/../g),v=>parseInt(v,16));
}
function toHex(bytes) {
  return Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
}
async function digest(keyHex,domain,values) {
  const key=await crypto.subtle.importKey('raw',keyBytes(keyHex),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const message=new TextEncoder().encode(
    'icop:staging:mfa-challenge:v1\n'+domain+'\n'+values.join('\n')
  );
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC',key,message)));
}
function statement(db,sql,...args) {return db.prepare(sql).bind(...args);}
async function trustedEmail(ctx) {
  const identity=await ctx.access.getIdentity();
  const email=identity?.email?.trim().toLowerCase();
  return typeof email==='string' && email.length<=254 && emailRe.test(email)
    ? email : null;
}
async function mappedUser(db,tenantCode,email) {
  return statement(db,`
    SELECT u.id,u.tenant_id,u.email_normalized,u.is_active,
      u.force_password_change,u.mfa_enabled,u.token_version
    FROM users u INNER JOIN tenants t ON t.id=u.tenant_id
    WHERE t.code=? AND u.email_normalized=? LIMIT 1
  `,tenantCode,email).first();
}

/** Require a verified password first-factor on the same Access identity. */
export async function issueMfaChallenge({
  ctx,db,env,tenantCode,password,ip,now=Math.floor(Date.now()/1000)
}) {
  if(!securityReady(env))return deny('STAGING_AUTH_NOT_READY');
  if(!accessReady(ctx,env))return deny('ACCESS_REQUIRED');
  if(!db?.prepare||!db?.batch||!tenantRe.test(tenantCode??'')||
    typeof password!=='string'||!password||password.length>128||
    !Number.isSafeInteger(now)||now<=0)return deny('AUTH_INVALID');
  try {keyBytes(env.AUTH_CHALLENGE_HMAC_KEY);keyBytes(env.ACCESS_AUDIT_HMAC_KEY);}
  catch{return deny('AUTH_KEYS_NOT_CONFIGURED');}
  const first=await verifyStagingFirstFactor({
    ctx,db,env,tenantCode,password,ip,now:now*1000
  });
  if(!first.ok && first.code!=='MFA_ENROLLMENT_REQUIRED')
    return deny(first?.code||'INVALID_CREDENTIALS');
  const purpose=first.ok?'mfa_login':'mfa_enroll';
  let user,email;
  try {
    email=await trustedEmail(ctx);
    if(!email)return deny('ACCESS_REQUIRED');
    user=await mappedUser(db,tenantCode,email);
  }catch{return deny('STAGING_DB_NOT_READY');}
  if(!user||!idRe.test(user.id??'')||!idRe.test(user.tenant_id??'')||
     user.email_normalized!==email||user.is_active!==1||
     user.force_password_change!==0 ||
     !Number.isSafeInteger(Number(user.token_version))||
     Number(user.token_version)<0 ||
     (purpose==='mfa_enroll'&&user.mfa_enabled!==0)||
     (purpose==='mfa_login'&&user.mfa_enabled!==1))
    return deny('AUTH_NOT_ALLOWED');
  const handle='m1_'+toHex(crypto.getRandomValues(new Uint8Array(32)));
  const version=Number(user.token_version),expiresAt=now+MAX_LIFETIME;
  let challengeHash,identityHash,auditHash;
  try {
    challengeHash=await digest(env.AUTH_CHALLENGE_HMAC_KEY,'handle',
      [user.tenant_id,user.id,purpose,handle]);
    identityHash=await digest(env.AUTH_CHALLENGE_HMAC_KEY,'identity',
      [user.tenant_id,user.id,email]);
    auditHash='hmac-sha256:'+await digest(env.ACCESS_AUDIT_HMAC_KEY,'network',
      [ip]);
  }catch{return deny('AUTH_KEYS_NOT_CONFIGURED');}
  try {
    // Do not trust a stale account snapshot; source row must still have its
    // originally checked token version and identity when persisting challenge.
    const sql=`
      INSERT INTO auth_mfa_challenges
        (challenge_hash,tenant_id,user_id,purpose,identity_hash,
         token_version,issued_at,expires_at)
      SELECT ?,u.tenant_id,u.id,?,?,u.token_version,?,?
      FROM users u INNER JOIN tenants t ON t.id=u.tenant_id
      WHERE t.code=? AND u.id=? AND u.email_normalized=?
        AND u.is_active=1 AND u.force_password_change=0
        AND u.token_version=? AND u.mfa_enabled=?
    `;
    const event=`
      INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip)
      SELECT c.tenant_id,c.user_id,'auth.mfa_challenge_issued','user',
             c.user_id,?
      FROM auth_mfa_challenges c
      WHERE c.challenge_hash=? AND c.tenant_id=? AND c.user_id=?
    `;
    const result=await db.batch([
      statement(db,sql,challengeHash,purpose,identityHash,now,expiresAt,
        tenantCode,user.id,email,version,purpose==='mfa_enroll'?0:1),
      statement(db,event,auditHash,challengeHash,user.tenant_id,user.id)
    ]);
    if(!Array.isArray(result)||result.length!==2||
       result.some(x=>x?.success!==true||Number(x.meta?.changes)!==1))
      return deny('AUTH_CHALLENGE_NOT_ISSUED');
  }catch{return deny('STAGING_DB_NOT_READY');}
  return {ok:true,purpose,challenge:handle,expiresAt,
    applicationAuthenticated:false,sessionIssued:false};
}

/**
 * Trusted internal lookup only; this is not an authorization grant.
 * Must NOT be exposed as a standalone HTTP endpoint.
 */
export async function resolveMfaChallenge({
  ctx,db,env,tenantCode,challenge,purpose,now=Math.floor(Date.now()/1000)
}) {
  if(!securityReady(env))return deny('STAGING_AUTH_NOT_READY');
  if(!accessReady(ctx,env))return deny('ACCESS_REQUIRED');
  if(!db?.prepare||!tenantRe.test(tenantCode??'')||
     !tokenRe.test(challenge??'')||
     !['mfa_enroll','mfa_login'].includes(purpose)||
     !Number.isSafeInteger(now)||now<=0)return deny('AUTH_INVALID');
  let user,email,row,challengeHash,identityHash;
  try {
    email=await trustedEmail(ctx);
    if(!email)return deny('ACCESS_REQUIRED');
    user=await mappedUser(db,tenantCode,email);
    if(!user||!idRe.test(user.id??'')||!idRe.test(user.tenant_id??'')||
       user.email_normalized!==email||user.is_active!==1||
       user.force_password_change!==0||
       !Number.isSafeInteger(Number(user.token_version))||
       (purpose==='mfa_enroll'&&user.mfa_enabled!==0)||
       (purpose==='mfa_login'&&user.mfa_enabled!==1))
      return deny('AUTH_CHALLENGE_INVALID');
    challengeHash=await digest(env.AUTH_CHALLENGE_HMAC_KEY,'handle',
      [user.tenant_id,user.id,purpose,challenge]);
    identityHash=await digest(env.AUTH_CHALLENGE_HMAC_KEY,'identity',
      [user.tenant_id,user.id,email]);
    row=await statement(db,`
      SELECT challenge_hash,tenant_id,user_id,purpose,identity_hash,
             token_version,issued_at,expires_at,consumed_at
      FROM auth_mfa_challenges WHERE challenge_hash=? LIMIT 1
    `,challengeHash).first();
  }catch{return deny('AUTH_CHALLENGE_INVALID');}
  if(!row||row.challenge_hash!==challengeHash||
     row.tenant_id!==user.tenant_id||row.user_id!==user.id||
     row.purpose!==purpose||row.identity_hash!==identityHash||
     Number(row.token_version)!==Number(user.token_version)||
     row.consumed_at!==null && row.consumed_at!==undefined ||
     !Number.isSafeInteger(Number(row.issued_at))||
     !Number.isSafeInteger(Number(row.expires_at))||
     now<Number(row.issued_at)||now>=Number(row.expires_at))
    return deny('AUTH_CHALLENGE_INVALID');
  return {ok:true,tenantId:user.tenant_id,userId:user.id,
    tokenVersion:Number(user.token_version),
    challengeHash,identityHash,expiresAt:Number(row.expires_at),
    purpose,applicationAuthenticated:false};
}

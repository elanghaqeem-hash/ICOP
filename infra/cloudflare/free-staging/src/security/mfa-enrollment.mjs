/**
 * ICOP staging-only U01 MFA setup: pending secret + one-time TOTP confirmation.
 * This module is NOT routed from HTTP or deployed. No app session is issued.
 * All inputs must be bound to a verified Cloudflare Access identity and an
 * unconsumed D1 challenge from a freshly verified password first-factor.
 *
 * This source must pass synthetic transaction/UAT and review before any
 * activation. A future HTTP adapter must reject cross-origin/CSRF and cap
 * retries, never log secrets, and show provisioning/recovery codes once.
 */
import {
  newTotpSecret,encryptTotpSecret,decryptTotpSecret,totpUri
} from './credentials.mjs';
import {matchTotp} from './totp.mjs';
import {createRecoveryCodes} from './recovery-codes.mjs';
import {resolveMfaChallenge} from './mfa-challenge.mjs';

const deny=code=>({ok:false,code});
const keyRe=/^[a-f0-9]{64}$/i;
const goodBatch=(rows,size)=>Array.isArray(rows)&&rows.length===size&&
  rows.every(x=>x?.success===true&&Number.isSafeInteger(Number(x.meta?.changes)));
const statement=(db,sql,...values)=>db.prepare(sql).bind(...values);
function permitted(env,confirm=false) {
  return env?.AUTH_V2_ENABLED==='true'&&
    env?.ACCESS_IDENTITY_ENABLED==='true'&&
    env?.ACCESS_MFA_CONFIRMED==='true'&&
    env?.PASSWORD_FIRST_FACTOR_ENABLED==='true'&&
    env?.MFA_CHALLENGE_ENABLED==='true'&&
    env?.MFA_ENROLLMENT_ENABLED==='true'&&
    (!confirm||env?.MFA_CONFIRM_ENABLED==='true');
}
async function auditIp(ip,keyHex) {
  if(typeof ip!=='string'||!/^[a-fA-F0-9:.]{3,64}$/.test(ip)||
     typeof keyHex!=='string'||!keyRe.test(keyHex))return null;
  const key=await crypto.subtle.importKey('raw',
    Uint8Array.from(keyHex.match(/../g),x=>parseInt(x,16)),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=await crypto.subtle.sign('HMAC',key,
    new TextEncoder().encode('icop:d1:audit:ip:v1:'+ip));
  return 'hmac-sha256:'+Array.from(new Uint8Array(signed),
    x=>x.toString(16).padStart(2,'0')).join('');
}
function lockUntil(value) {
  if(value===null||value===undefined||value==='')return 0;
  if(typeof value!=='string')return Infinity;
  const iso=/^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d$/.test(value)
    ? value.replace(' ','T')+'Z' : value;
  const ms=Date.parse(iso);
  return Number.isFinite(ms)?ms:Infinity;
}
async function pendingUser(db,proof) {
  return statement(db,`
    SELECT id,tenant_id,email_normalized,is_active,force_password_change,
      mfa_enabled,mfa_secret_enc,mfa_pending_secret_enc,mfa_pending_expires_at,
      mfa_last_step,mfa_failed_attempts,mfa_locked_until,token_version
    FROM users WHERE tenant_id=? AND id=? LIMIT 1
  `,proof.tenantId,proof.userId).first();
}

/** Stage TOTP secret, never session. A retry must not silently rotate it. */
export async function beginMfaEnrollment({
  ctx,db,env,tenantCode,challenge,ip,now=Math.floor(Date.now()/1000)
}) {
  if(!permitted(env))return deny('STAGING_AUTH_NOT_READY');
  if(!db?.prepare||!db?.batch||!Number.isSafeInteger(now)||now<=0)
    return deny('AUTH_INVALID');
  if(!keyRe.test(env.MFA_ENCRYPTION_KEY??''))
    return deny('MFA_ENCRYPTION_KEY_NOT_CONFIGURED');
  const proof=await resolveMfaChallenge({
    ctx,db,env,tenantCode,challenge,purpose:'mfa_enroll',now
  });
  if(!proof.ok)return deny(proof.code);
  let user,email;
  try {
    user=await pendingUser(db,proof);
    email=(await ctx.access.getIdentity())?.email?.trim().toLowerCase();
  }catch{return deny('STAGING_DB_NOT_READY');}
  if(!user||user.is_active!==1||user.force_password_change!==0||
    user.mfa_enabled!==0||Number(user.token_version)!==proof.tokenVersion||
    user.mfa_pending_secret_enc!==null&&user.mfa_pending_secret_enc!==undefined||
    typeof email!=='string'||user.email_normalized!==email)
    return deny('MFA_ENROLLMENT_NOT_ALLOWED');
  const ipHash=await auditIp(ip,env.ACCESS_AUDIT_HMAC_KEY);
  if(!ipHash)return deny('STAGING_AUDIT_NOT_CONFIGURED');
  let secret,encrypted,uri;
  try {
    secret=newTotpSecret();
    encrypted=await encryptTotpSecret({
      secret,keyHex:env.MFA_ENCRYPTION_KEY,
      tenantId:proof.tenantId,userId:proof.userId
    });
    uri=totpUri(secret,email);
  }catch{return deny('MFA_ENCRYPTION_KEY_NOT_CONFIGURED');}
  const expiry=new Date(proof.expiresAt*1000).toISOString();
  try {
    const updates=await db.batch([
      statement(db,`
        UPDATE users
        SET mfa_pending_secret_enc=?,mfa_pending_expires_at=?
        WHERE tenant_id=? AND id=? AND token_version=? AND is_active=1
          AND force_password_change=0 AND mfa_enabled=0
          AND mfa_pending_secret_enc IS NULL
          AND EXISTS (SELECT 1 FROM auth_mfa_challenges c
            WHERE c.challenge_hash=? AND c.tenant_id=users.tenant_id
              AND c.user_id=users.id AND c.consumed_at IS NULL
              AND c.expires_at>? AND c.issued_at<=? AND c.purpose='mfa_enroll'
              AND c.token_version=users.token_version)
      `,encrypted,expiry,proof.tenantId,proof.userId,proof.tokenVersion,
        proof.challengeHash,now,now),
      statement(db,`
        INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip)
        SELECT tenant_id,id,'auth.mfa_enroll_started','user',id,?
        FROM users WHERE tenant_id=? AND id=? AND mfa_pending_secret_enc=?
      `,ipHash,proof.tenantId,proof.userId,encrypted)
    ]);
    if(!goodBatch(updates,2)||updates.some(x=>Number(x.meta.changes)!==1))
      return deny('MFA_ENROLLMENT_CONFLICT');
  }catch{return deny('STAGING_DB_NOT_READY');}
  // URI necessarily contains the TOTP seed. Never log, cache or show it twice.
  return {ok:true,provisioningUri:uri,expiresAt:proof.expiresAt,
    sessionIssued:false,applicationAuthenticated:false};
}

/**
 * Confirm the pending TOTP via WebCrypto, then persist enrollment, one-time
 * challenge consumption, step replay guard, 10 keyed recovery digests and
 * audit in one D1 batch. None of this is a login or issues bearer sessions.
 */
export async function confirmMfaEnrollment({
  ctx,db,env,tenantCode,challenge,code,ip,now=Math.floor(Date.now()/1000)
}) {
  if(!permitted(env,true))return deny('STAGING_AUTH_NOT_READY');
  if(!db?.prepare||!db?.batch||!Number.isSafeInteger(now)||now<=0||
     typeof code!=='string'||!/^\d{6}$/.test(code))
    return deny('AUTH_INVALID');
  if(!keyRe.test(env.MFA_ENCRYPTION_KEY??'')||
     !keyRe.test(env.MFA_RECOVERY_HMAC_KEY??''))
    return deny('AUTH_KEYS_NOT_CONFIGURED');
  const proof=await resolveMfaChallenge({
    ctx,db,env,tenantCode,challenge,purpose:'mfa_enroll',now
  });
  if(!proof.ok)return deny(proof.code);
  let user,secret;
  try {
    user=await pendingUser(db,proof);
    if(!user||user.is_active!==1||user.force_password_change!==0||
       user.mfa_enabled!==0||Number(user.token_version)!==proof.tokenVersion||
       typeof user.mfa_pending_secret_enc!=='string' ||
       Date.parse(user.mfa_pending_expires_at)<=now*1000 ||
       !Number.isFinite(Date.parse(user.mfa_pending_expires_at)))
      return deny('MFA_ENROLLMENT_EXPIRED');
    secret=await decryptTotpSecret({
      encrypted:user.mfa_pending_secret_enc,keyHex:env.MFA_ENCRYPTION_KEY,
      tenantId:proof.tenantId,userId:proof.userId
    });
  }catch{return deny('MFA_ENROLLMENT_INVALID');}
  if(lockUntil(user.mfa_locked_until)>now*1000)
    return deny('MFA_ACCOUNT_LOCKED');
  let step=null;
  try {step=await matchTotp(secret,code,-1,now*1000);}
  catch {step=null;}
  const ipHash=await auditIp(ip,env.ACCESS_AUDIT_HMAC_KEY);
  if(!ipHash)return deny('STAGING_AUDIT_NOT_CONFIGURED');
  if(step===null) {
    // Global to the tenant/user, not each challenge. Password is not logged.
    try {
      const failures=await db.batch([
        statement(db,`
          UPDATE users SET mfa_failed_attempts=mfa_failed_attempts+1,
            mfa_locked_until=CASE WHEN mfa_failed_attempts+1>=5
              THEN datetime(?,'unixepoch','+15 minutes')
              ELSE mfa_locked_until END
          WHERE tenant_id=? AND id=? AND is_active=1 AND mfa_enabled=0
            AND token_version=? AND mfa_pending_secret_enc=?
            AND (mfa_locked_until IS NULL OR unixepoch(mfa_locked_until)<=?)
        `,now,proof.tenantId,proof.userId,proof.tokenVersion,
          user.mfa_pending_secret_enc,now),
        statement(db,`
          INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip)
          SELECT tenant_id,id,'auth.mfa_enroll_code_rejected','user',id,?
          FROM users WHERE tenant_id=? AND id=?
            AND mfa_pending_secret_enc=? AND mfa_enabled=0
        `,ipHash,proof.tenantId,proof.userId,user.mfa_pending_secret_enc)
      ]);
      if(!goodBatch(failures,2)||
         failures.some(x=>Number(x.meta.changes)!==1))
        return deny('STAGING_DB_NOT_READY');
    }catch{return deny('STAGING_DB_NOT_READY');}
    return deny('MFA_INVALID');
  }
  let codes,hashes,generation;
  try {
    ({codes,hashes}=await createRecoveryCodes({
      secret:env.MFA_RECOVERY_HMAC_KEY,
      tenantId:proof.tenantId,userId:proof.userId
    }));
    const last=await statement(db,`
      SELECT COALESCE(MAX(generation),0) AS current_generation
      FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?
    `,proof.tenantId,proof.userId).first();
    generation=Number(last?.current_generation)+1;
    if(!Number.isSafeInteger(generation)||generation<=0)
      return deny('MFA_ENROLLMENT_INVALID');
  }catch{return deny('MFA_RECOVERY_NOT_CONFIGURED');}
  const nextVersion=proof.tokenVersion+1;
  if(!Number.isSafeInteger(nextVersion)||nextVersion>=2147483647)
    return deny('AUTH_INVALID');
  const afterVersion=nextVersion;
  const scoped=[proof.tenantId,proof.userId];
  try {
    const statements=[
      statement(db,`
        UPDATE auth_mfa_challenges SET consumed_at=?
        WHERE challenge_hash=? AND tenant_id=? AND user_id=?
          AND identity_hash=? AND purpose='mfa_enroll'
          AND token_version=? AND consumed_at IS NULL
          AND issued_at<=? AND expires_at>?
      `,now,proof.challengeHash,...scoped,proof.identityHash,
         proof.tokenVersion,now,now),
      statement(db,`
        UPDATE users SET mfa_enabled=1,mfa_secret_enc=mfa_pending_secret_enc,
          mfa_pending_secret_enc=NULL,mfa_pending_expires_at=NULL,
          mfa_last_step=?,mfa_enrolled_at=datetime(?,'unixepoch'),
          mfa_failed_attempts=0,mfa_locked_until=NULL,token_version=?
        WHERE tenant_id=? AND id=? AND token_version=?
          AND is_active=1 AND force_password_change=0 AND mfa_enabled=0
          AND mfa_pending_secret_enc=?
          AND unixepoch(mfa_pending_expires_at)>?
          AND (mfa_locked_until IS NULL OR unixepoch(mfa_locked_until)<=?)
          AND EXISTS(SELECT 1 FROM auth_mfa_challenges c
            WHERE c.challenge_hash=? AND c.tenant_id=users.tenant_id
              AND c.user_id=users.id AND c.consumed_at=?)
      `,step,now,afterVersion,...scoped,proof.tokenVersion,
         user.mfa_pending_secret_enc,now,now,proof.challengeHash,now),
      statement(db,`
        INSERT INTO mfa_used_steps(tenant_id,user_id,totp_step,used_at)
        SELECT tenant_id,id,?,? FROM users WHERE tenant_id=? AND id=?
          AND mfa_enabled=1 AND mfa_last_step=? AND token_version=?
      `,step,now,...scoped,step,afterVersion)
    ];
    for(const hash of hashes) {
      statements.push(statement(db,`
        INSERT INTO mfa_recovery_codes
          (tenant_id,user_id,code_hash,generation,issued_at,expires_at)
        SELECT tenant_id,id,?,?,?,? FROM users
        WHERE tenant_id=? AND id=? AND mfa_enabled=1 AND mfa_last_step=?
          AND token_version=?
      `,hash,generation,now,now+90*86400,
         ...scoped,step,afterVersion));
    }
    statements.push(statement(db,`
      INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip)
      SELECT tenant_id,id,'auth.mfa_enrolled','user',id,?
      FROM users WHERE tenant_id=? AND id=? AND mfa_enabled=1
        AND token_version=? AND mfa_last_step=?
    `,ipHash,...scoped,afterVersion,step));
    const result=await db.batch(statements);
    if(!goodBatch(result,statements.length)||
       result.some(x=>Number(x.meta.changes)!==1))
      return deny('MFA_ENROLLMENT_CONFLICT');
  }catch{return deny('MFA_ENROLLMENT_FAILED');}
  return {ok:true,mfaEnabled:true,recoveryCodes:codes,sessionIssued:false,
    applicationAuthenticated:false,loginRequired:true};
}

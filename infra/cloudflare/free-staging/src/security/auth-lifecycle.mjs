/**
 * Staging-only, server-side D1 lifecycle based on Phase 6/UAT U01-U02-U24.
 * A trusted caller must first verify Access identity, password and tenant.
 * No public HTTP route, seed account, or auth bypass is installed here.
 */
import { newSessionToken, hashSessionToken } from './session.mjs';
import { matchTotp } from './totp.mjs';
import { decryptTotpSecret } from './credentials.mjs';
import { planMfaReset } from './mfa-reset-policy.mjs';
import { createRecoveryCodes, hashRecoveryCode } from './recovery-codes.mjs';

const idRe=/^[A-Za-z0-9_-]{2,128}$/;
const keyRe=/^[a-f0-9]{64}$/i;
const deny=(code)=>({ok:false,code});
const stmt=(db,sql,...args)=>db.prepare(sql).bind(...args);
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const subject=(a,b)=>idRe.test(a??'')&&idRe.test(b??'');

async function networkDigest(ip,secret) {
  if(!keyRe.test(secret??'')||typeof ip!=='string'||
    !/^[a-fA-F0-9:.]{3,64}$/.test(ip))return null;
  const key=await crypto.subtle.importKey('raw',
    Uint8Array.from(secret.match(/../g),p=>parseInt(p,16)),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  return 'hmac-sha256:'+hex(await crypto.subtle.sign('HMAC',key,
    new TextEncoder().encode('icop:d1:audit:ip:v1:'+ip)));
}
const goodBatch=(rows,n)=>Array.isArray(rows)&&rows.length===n&&
  rows.every(r=>r?.success===true);

/** Unique mfa_used_steps and D1 batch transaction prevent replay/partial
 * session issuance. No D1/crypto failures ever grant a session. */
export async function finishTotpAndIssueSession({db,tenantId,userId,code,ip,keys,
  now=Math.floor(Date.now()/1000)}) {
  if(!db?.prepare||!db?.batch||!subject(tenantId,userId)||
    !Number.isSafeInteger(now)||now<0)return deny('AUTH_INVALID');
  if(!keys?.session||!keys?.encryption||!keys?.audit)
    return deny('AUTH_KEYS_NOT_CONFIGURED');
  let u;
  try {
    u=await stmt(db,'SELECT id,tenant_id,role,is_active,force_password_change,mfa_enabled,mfa_secret_enc,mfa_last_step,token_version FROM users WHERE tenant_id=? AND id=? LIMIT 1',tenantId,userId).first();
  }catch{return deny('AUTH_DB_UNAVAILABLE');}
  if(!u||u.is_active!==1||u.force_password_change!==0||
    u.mfa_enabled!==1||!Number.isSafeInteger(Number(u.token_version))||
    Number(u.token_version)<0)return deny('AUTH_NOT_ALLOWED');
  let step;
  try {
    const secret=await decryptTotpSecret({
      encrypted:u.mfa_secret_enc,keyHex:keys.encryption,tenantId,userId});
    step=await matchTotp(secret,code,
      u.mfa_last_step===null?-1:Number(u.mfa_last_step),now*1000);
  }catch{return deny('MFA_INVALID');}
  if(step===null)return deny('MFA_INVALID');
  const ipHash=await networkDigest(ip,keys.audit);
  if(!ipHash)return deny('AUTH_AUDIT_NOT_CONFIGURED');
  const token=newSessionToken();
  const hashed=await hashSessionToken(token,keys.session);
  if(!hashed)return deny('AUTH_KEYS_NOT_CONFIGURED');
  try {
    const x=await db.batch([
      stmt(db,'INSERT INTO mfa_used_steps(tenant_id,user_id,totp_step,used_at) VALUES(?,?,?,?)',tenantId,userId,step,now),
      stmt(db,'UPDATE users SET mfa_last_step=?, failed_logins=0 WHERE tenant_id=? AND id=? AND (mfa_last_step IS NULL OR mfa_last_step<?) AND is_active=1 AND mfa_enabled=1 AND token_version=?',step,tenantId,userId,step,Number(u.token_version)),
      stmt(db,'INSERT INTO auth_sessions(session_id_hash,tenant_id,user_id,token_version,mfa_verified,issued_at,expires_at) VALUES(?,?,?,?,1,?,?)',hashed,tenantId,userId,Number(u.token_version),now,now+28800),
      stmt(db,"INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip) VALUES(?,?,'auth.login_mfa_verified','user',?,?)",tenantId,userId,userId,ipHash)
    ]);
    if(!goodBatch(x,4)||x.some(y=>Number(y.meta?.changes)!==1))
      return deny('AUTH_DB_UNAVAILABLE');
  }catch{return deny('MFA_REPLAY_OR_DB_ERROR');}
  return {ok:true,sessionToken:token,expiresAt:now+28800};
}

/** 10 UAT U01 codes displayed once. D1 stores only keyed hashes. The
 * caller must already have passed a real MFA enrollment confirmation. */
export async function issueRecoveryAfterMfa({db,tenantId,userId,key,ip,auditKey,
  now=Math.floor(Date.now()/1000)}) {
  if(!db?.prepare||!db?.batch||!subject(tenantId,userId)||
     !Number.isSafeInteger(now)||now<=0)return deny('AUTH_INVALID');
  const ipHash=await networkDigest(ip,auditKey);
  if(!ipHash)return deny('AUTH_AUDIT_NOT_CONFIGURED');
  let codes,hashes;
  try {({codes,hashes}=await createRecoveryCodes({secret:key,tenantId,userId}));}
  catch{return deny('MFA_RECOVERY_KEY_NOT_CONFIGURED');}
  try {
    const u=await stmt(db,'SELECT is_active,mfa_enabled FROM users WHERE tenant_id=? AND id=? LIMIT 1',tenantId,userId).first();
    if(u?.is_active!==1||u?.mfa_enabled!==1)return deny('AUTH_NOT_ALLOWED');
    const max=await stmt(db,'SELECT COALESCE(MAX(generation),0) AS maximum FROM mfa_recovery_codes WHERE tenant_id=? AND user_id=?',tenantId,userId).first();
    const generation=Number(max?.maximum)+1;
    if(!Number.isSafeInteger(generation)||generation<1)return deny('AUTH_DB_UNAVAILABLE');
    const commands=[
      stmt(db,'UPDATE mfa_recovery_codes SET revoked_at=? WHERE tenant_id=? AND user_id=? AND consumed_at IS NULL AND revoked_at IS NULL',now,tenantId,userId),
      ...hashes.map(h=>stmt(db,'INSERT INTO mfa_recovery_codes(tenant_id,user_id,code_hash,generation,issued_at,expires_at) VALUES(?,?,?,?,?,?)',tenantId,userId,h,generation,now,now+90*86400)),
      stmt(db,"INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip) VALUES(?,?,'auth.mfa_recovery_issued','user',?,?)",tenantId,userId,userId,ipHash),
    ];
    const result=await db.batch(commands);
    if(!goodBatch(result,commands.length)||
       result.slice(1).some(x=>Number(x.meta?.changes)!==1))
      return deny('AUTH_DB_UNAVAILABLE');
  }catch{return deny('AUTH_DB_UNAVAILABLE');}
  return {ok:true,recoveryCodes:codes};
}

/** UAT U02/U24: server-verified actor; role/tenant/MFA never trusted from
 * client body. Atomic DB mutation, token_version and audit or all fail. */
export async function resetUserMfa({db,actor,targetId,reason,ip,auditKey,
  now=Math.floor(Date.now()/1000)}) {
  if(!db?.prepare||!db?.batch||!subject(actor?.tenantId,targetId)||
     !Number.isSafeInteger(now)||now<=0)return deny('AUTH_INVALID');
  const ipHash=await networkDigest(ip,auditKey);
  if(!ipHash)return deny('AUTH_AUDIT_NOT_CONFIGURED');
  let t;
  try {
    t=await stmt(db,'SELECT id,tenant_id,is_active,token_version FROM users WHERE tenant_id=? AND id=? LIMIT 1',actor.tenantId,targetId).first();
  }catch{return deny('AUTH_DB_UNAVAILABLE');}
  if(!t)return deny('TARGET_NOT_FOUND');
  const decision=planMfaReset({actor,target:{
    id:t.id,tenantId:t.tenant_id,isActive:t.is_active===1,
    tokenVersion:Number(t.token_version)},reason});
  if(!decision.allowed)return deny(decision.code);
  const p=decision.plan;
  try {
    const x=await db.batch([
      stmt(db,'UPDATE users SET mfa_enabled=0,mfa_secret_enc=NULL,mfa_pending_secret_enc=NULL,mfa_last_step=NULL,token_version=? WHERE tenant_id=? AND id=? AND token_version=?',p.nextTokenVersion,p.tenantId,p.targetId,t.token_version),
      stmt(db,'UPDATE auth_sessions SET revoked_at=? WHERE tenant_id=? AND user_id=? AND revoked_at IS NULL',now,p.tenantId,p.targetId),
      stmt(db,'UPDATE mfa_recovery_codes SET revoked_at=? WHERE tenant_id=? AND user_id=? AND consumed_at IS NULL AND revoked_at IS NULL',now,p.tenantId,p.targetId),
      stmt(db,"INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,after_json,ip) VALUES(?,?,'auth.mfa_reset','user',?,?,?)",p.tenantId,p.actorId,p.targetId,JSON.stringify({reason:p.reason,reenroll:true}),ipHash)
    ]);
    if(!goodBatch(x,4)||Number(x[0].meta?.changes)!==1||
       Number(x[3].meta?.changes)!==1)return deny('AUTH_DB_UNAVAILABLE');
  }catch{return deny('AUTH_DB_UNAVAILABLE');}
  return {ok:true,sessionsRevoked:true,reenrollmentRequired:true};
}


/** UAT U01: conditional one-time recovery consumption.
 * A wrong/reused/expired code never causes a token to be returned.
 * A verified, tenant-scoped first-factor subject MUST be supplied by a
 * trusted server handler, never from a browser-provided user identifier.
 */
export async function consumeRecoveryAndIssueSession({db,tenantId,userId,code,
  recoveryKey,keys,ip,now=Math.floor(Date.now()/1000)}) {
  if(!db?.prepare||!db?.batch||!subject(tenantId,userId)||
     !Number.isSafeInteger(now)||now<=0)return deny('AUTH_INVALID');
  if(!keys?.session||!keys?.audit)return deny('AUTH_KEYS_NOT_CONFIGURED');
  const ipHash=await networkDigest(ip,keys.audit);
  if(!ipHash)return deny('AUTH_AUDIT_NOT_CONFIGURED');
  let hashedCode;
  try {
    hashedCode=await hashRecoveryCode({secret:recoveryKey,tenantId,userId,code});
  }catch{return deny('MFA_RECOVERY_INVALID');}
  let user;
  try {
    user=await stmt(db,'SELECT token_version,is_active,mfa_enabled,force_password_change FROM users WHERE tenant_id=? AND id=? LIMIT 1',tenantId,userId).first();
  }catch{return deny('AUTH_DB_UNAVAILABLE');}
  if(user?.is_active!==1||user?.mfa_enabled!==1||
     user?.force_password_change!==0||
     !Number.isSafeInteger(Number(user?.token_version)))
    return deny('AUTH_NOT_ALLOWED');
  const token=newSessionToken();
  const digest=await hashSessionToken(token,keys.session);
  if(!digest)return deny('AUTH_KEYS_NOT_CONFIGURED');
  try {
    const x=await db.batch([
      stmt(db,'UPDATE mfa_recovery_codes SET consumed_at=? WHERE tenant_id=? AND user_id=? AND code_hash=? AND consumed_at IS NULL AND revoked_at IS NULL AND issued_at<=? AND expires_at>=?',now,tenantId,userId,hashedCode,now,now),
      stmt(db,'INSERT INTO auth_sessions(session_id_hash,tenant_id,user_id,token_version,mfa_verified,issued_at,expires_at) VALUES(?,?,?,?,1,?,?)',digest,tenantId,userId,Number(user.token_version),now,now+28800),
      stmt(db,"INSERT INTO audit_events(tenant_id,actor_id,action,entity_type,entity_id,ip) VALUES(?,?,'auth.mfa_recovery_used','user',?,?)",tenantId,userId,userId,ipHash)
    ]);
    // D1 UPDATE has to change exactly one row. A replay can never return a
    // bearer token, even when later statements completed in the same batch.
    if(!goodBatch(x,3)||x.some(y=>Number(y.meta?.changes)!==1))
      return deny('MFA_RECOVERY_INVALID');
  }catch{return deny('MFA_RECOVERY_INVALID');}
  return {ok:true,sessionToken:token,expiresAt:now+28800};
}

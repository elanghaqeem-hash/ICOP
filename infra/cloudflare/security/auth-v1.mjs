// ICOP Cloudflare staging authentication. Deliberately independent from production Fastify.
// Access verifies the human identity and enforces MFA outside this Worker.
// Local password provides an additional factor; no session is issued before both gates pass.
const APPROVED_EMAIL = 'elang.haqeem@gmail.com';
const TENANT = 'DEIT';
const SESSION = '__Host-icop-staging-session';
const ITERATIONS = 600000;
const TTL = 1800;
const te = new TextEncoder();
const hex = x => Array.from(x, b => b.toString(16).padStart(2, '0')).join('');
const unhex = x => Uint8Array.from(x.match(/../g) || [], c => parseInt(c, 16));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const response = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer', ...headers }
});
const error = (s,c) => response(s,{code:c});
const cookie = token => SESSION+'='+token+'; Path=/; Max-Age='+TTL+'; Secure; HttpOnly; SameSite=Strict';
const clearCookie = () => SESSION+'=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict';
const now = () => Math.floor(Date.now()/1000);

function enabled(env) {
  return env.ACCESS_IDENTITY_ENABLED === 'true' &&
    env.ACCESS_MFA_CONFIRMED === 'true' &&
    env.AUTH_V2_ENABLED === 'true' &&
    typeof env.ACCESS_AUD === 'string' &&
    typeof env.SESSION_HMAC_KEY === 'string' &&
    /^[a-f0-9]{64}$/i.test(env.SESSION_HMAC_KEY) &&
    !!env.DB?.prepare;
}
async function principal(env, ctx) {
  if (!ctx?.access?.getIdentity || ctx.access.aud !== env.ACCESS_AUD) return null;
  try {
    const id = await ctx.access.getIdentity();
    const email = (id?.email || '').trim().toLowerCase();
    return email === APPROVED_EMAIL ? email : null;
  } catch { return null; }
}
function sameOrigin(request) {
  const actual = request.headers.get('origin');
  return actual !== null && actual === new URL(request.url).origin;
}
async function bodyFrom(request) {
  if (Number(request.headers.get('content-length') || 0) > 8192) return null;
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json') && !type.includes('application/x-www-form-urlencoded')) return null;
  try {
    const text = await request.text();
    if (text.length > 8192) return null;
    return type.includes('application/json') ? JSON.parse(text) :
      Object.fromEntries(new URLSearchParams(text));
  } catch { return null; }
}
function goodPassword(s) {
  return typeof s==='string' && s.length>=16 && s.length<=128 &&
    /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s) &&
    /[^A-Za-z0-9]/.test(s);
}
async function derive(pass,salt,iter=ITERATIONS) {
  const k=await crypto.subtle.importKey('raw',te.encode(pass),'PBKDF2',false,['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({
    name:'PBKDF2',salt:unhex(salt),iterations:iter,hash:'SHA-256'
  },k,256)));
}
async function passwordHash(pass) {
  const salt=hex(rand(16));
  return 'pbkdf2-sha256$'+ITERATIONS+'$'+salt+'$'+await derive(pass,salt);
}
function equalHex(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
  let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;
}
async function checkPassword(pass,encoded) {
  if (typeof pass!=='string'|| pass.length>256 || typeof encoded!=='string') return false;
  const p=encoded.split('$');
  if(p.length!==4||p[0]!=='pbkdf2-sha256'||p[1]!==String(ITERATIONS)||
    !/^[a-f0-9]{32}$/i.test(p[2])||!/^[a-f0-9]{64}$/i.test(p[3]))return false;
  return equalHex(await derive(pass,p[2]),p[3]);
}
async function tokenHash(token,key) {
  if (typeof token!=='string'||!/^(s1_)[a-f0-9]{64}$/.test(token))return null;
  const k=await crypto.subtle.importKey('raw',unhex(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC',k,te.encode(token))));
}
function readCookie(request) {
  const c=request.headers.get('cookie')||'';
  const p=c.split(';').map(x=>x.trim()).find(x=>x.startsWith(SESSION+'='));
  return p?p.slice(SESSION.length+1):null;
}
async function audit(db,user,action) {
  try {
    await db.prepare('INSERT INTO audit_events (tenant_id,actor_id,action,entity_type,entity_id) VALUES (?,?,?,?,?)')
      .bind(user.tenant_id,user.id,action,'user',user.id).run();
  } catch { /* no secrets, fail closed at authentication if auditing is broken */ throw new Error('AUDIT_NOT_READY'); }
}
async function userFor(db,email) {
  return db.prepare('SELECT u.* FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE t.code=? AND u.email_normalized=? LIMIT 1')
    .bind(TENANT,email).first();
}
async function activate(env,email,data) {
  if (env.AUTH_ACTIVATION_ENABLED !== 'true') return error(503,'ACTIVATION_NOT_APPROVED');
  const pw=data?.newPassword;
  if(!goodPassword(pw))return error(400,'PASSWORD_POLICY_MIN_16_MIXED_CASE_DIGIT_SYMBOL');
  const db=env.DB, tenant=await db.prepare('SELECT id FROM tenants WHERE code=? LIMIT 1').bind(TENANT).first();
  if(!tenant)return error(503,'TENANT_NOT_PROVISIONED');
  const prior=await userFor(db,email);
  if (prior && (prior.is_active!==0 || prior.password_hash!=='!pending-cloudflare-activation!'))
    return error(409,'ACCOUNT_ALREADY_EXISTS_OR_REQUIRES_REVIEW');
  const hash=await passwordHash(pw);
  if(!prior) {
    await db.prepare('INSERT OR IGNORE INTO users (id,tenant_id,email,email_normalized,full_name,password_hash,role,is_active,force_password_change,mfa_enabled) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),tenant.id,email,email,'ICOP System Administrator','!pending-cloudflare-activation!','super_admin',0,1,0).run();
  }
  // Only a pending identity inserted by this flow can be activated.
  const result=await db.prepare("UPDATE users SET password_hash=?,is_active=1,force_password_change=0,mfa_enabled=1,token_version=token_version+1,updated_at=datetime('now') WHERE tenant_id=? AND email_normalized=? AND password_hash='!pending-cloudflare-activation!' AND is_active=0")
    .bind(hash,tenant.id,email).run();
  if (result.meta?.changes!==1) return error(409,'ACTIVATION_CONFLICT');
  const user=await userFor(db,email);
  await audit(db,user,'auth.activated_via_cloudflare_access_mfa');
  return response(200,{status:'activated',email,loginUrl:'/login'});
}
async function login(env,email,data) {
  if(data?.tenant!==TENANT || typeof data?.email!=='string' ||
     data.email.trim().toLowerCase()!==email || typeof data.password!=='string')
    return error(401,'INVALID_CREDENTIALS');
  const db=env.DB, user=await userFor(db,email);
  if(!user||user.is_active!==1||user.mfa_enabled!==1) return error(401,'INVALID_CREDENTIALS');
  if(user.locked_until && Date.parse(user.locked_until)>Date.now()) return error(423,'ACCOUNT_TEMPORARILY_LOCKED');
  if(!await checkPassword(data.password,user.password_hash)) {
    const failed=Number(user.failed_logins||0)+1;
    await db.prepare("UPDATE users SET failed_logins=?,locked_until=CASE WHEN ?>=5 THEN datetime('now','+15 minutes') ELSE NULL END WHERE id=?")
      .bind(failed,failed,user.id).run();
    await audit(db,user,'auth.login_failed');
    return error(401,'INVALID_CREDENTIALS');
  }
  await db.prepare('UPDATE users SET failed_logins=0,locked_until=NULL WHERE id=?').bind(user.id).run();
  const token='s1_'+hex(rand(32));
  const digest=await tokenHash(token,env.SESSION_HMAC_KEY);
  const t=now();
  await db.prepare('INSERT INTO auth_sessions (session_id_hash,tenant_id,user_id,token_version,mfa_verified,issued_at,expires_at) VALUES (?,?,?,?,?,?,?)')
    .bind(digest,user.tenant_id,user.id,user.token_version,1,t,t+TTL).run();
  await audit(db,user,'auth.login_access_mfa_password');
  return response(200,{
    applicationAuthenticated:true,mfaVerified:true,
    user:{id:user.id,email:user.email,role:user.role,tenantId:user.tenant_id,forcePasswordChange:false,mfaEnabled:true},
    accessRequiredForEveryRequest:true
  },{'set-cookie':cookie(token)});
}
async function session(env,request,email) {
  const token=readCookie(request);
  const hash=await tokenHash(token,env.SESSION_HMAC_KEY);
  if(!hash)return null;
  const record=await env.DB.prepare('SELECT s.*,u.email_normalized,u.email,u.role,u.is_active,u.mfa_enabled,u.token_version AS user_token_version,u.force_password_change FROM auth_sessions s JOIN users u ON u.id=s.user_id AND u.tenant_id=s.tenant_id WHERE s.session_id_hash=? LIMIT 1')
    .bind(hash).first();
  if(!record||record.email_normalized!==email||record.is_active!==1||
     record.mfa_enabled!==1||record.mfa_verified!==1||
     record.force_password_change!==0||record.revoked_at!==null||
     record.token_version!==record.user_token_version||
     record.issued_at>now()||record.expires_at<=now())return null;
  return {record,hash};
}
const html = (title,body) => new Response('<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>'+title+'</title><style>body{font:16px system-ui;background:#f2f5fa;color:#1d2c48;padding:2rem;max-width:32rem;margin:auto}main{background:white;border-radius:18px;padding:2rem;box-shadow:0 10px 35px #142a501a}label{display:block;margin:1rem 0}input{box-sizing:border-box;width:100%;font:inherit;padding:.8rem;border:1px solid #ccd4e2;border-radius:9px}button{background:#284979;color:white;border:0;border-radius:9px;padding:1rem;width:100%;font:inherit}small{color:#687789}</style><main><h1>'+title+'</h1>'+body+'<p><small>Akses melalui Cloudflare Access dan MFA diwajibkan. Jangan gunakan password yang pernah muncul dalam screenshot.</small></p></main></html>',
  {headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'","x-content-type-options":"nosniff","referrer-policy":"no-referrer"}});
export async function handleAuthV1(request,env,ctx) {
  const path=new URL(request.url).pathname;
  if (!['/activate','/login','/api/v1/auth/access-check','/api/v1/auth/activate','/api/v1/auth/login','/api/v1/auth/me','/api/v1/auth/logout'].includes(path))return null;
  // Check runtime-verified Access identity BEFORE feature flags. Deny unauthenticated
  // requests even when activation is disabled: no route should emit a readiness 503
  // to someone Cloudflare Access did not identify.
  const email=await principal(env,ctx);
  if(!email)return error(403,'CLOUDFLARE_ACCESS_VERIFIED_IDENTITY_REQUIRED');
  // Read-only diagnostic: no account, password or session state exposed. This must
  // work while release gates are off to validate the Cloudflare Access integration.
  if(path==='/api/v1/auth/access-check') {
    if(request.method!=='GET')return error(405,'METHOD_NOT_ALLOWED');
    return response(200,{status:'access_identity_verified',accessAuthenticated:true,
      applicationAuthenticated:false,activationReady:enabled(env)&&env.AUTH_ACTIVATION_ENABLED==='true',
      note:'MFA enforcement is configured in Access; real MFA UAT must be verified separately.'});
  }
  if(!enabled(env))return error(503,'STAGING_AUTH_GATES_PENDING');
  if(request.method==='GET'&&path==='/activate')
    return html('Aktivasi Administrator ICOP','<p>Siapkan password baru yang belum pernah digunakan. Cloudflare Access harus sudah memverifikasi email dan MFA Anda.</p><form method="post" action="/api/v1/auth/activate"><label>Password baru (minimal 16 karakter)<input type="password" name="newPassword" minlength="16" autocomplete="new-password" required></label><button>Aktifkan akun saya</button></form>');
  if(request.method==='GET'&&path==='/login')
    return html('Login Administrator ICOP','<form method="post" action="/api/v1/auth/login"><input type="hidden" name="tenant" value="DEIT"><label>Email<input type="email" name="email" value="elang.haqeem@gmail.com" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button>Masuk</button></form>');
  if(request.method==='GET'&&path==='/api/v1/auth/me') {
    const s=await session(env,request,email);
    if(!s)return error(401,'SESSION_REQUIRED');
    return response(200,{applicationAuthenticated:true,mfaVerified:true,
      user:{id:s.record.user_id,email:s.record.email,role:s.record.role,tenantId:s.record.tenant_id}});
  }
  if(request.method==='POST' && !sameOrigin(request)) return error(403,'ORIGIN_REQUIRED');
  const data=request.method==='POST'?await bodyFrom(request):null;
  if(request.method==='POST'&&!data)return error(400,'BAD_REQUEST');
  try {
    if(path==='/api/v1/auth/activate'&&request.method==='POST')return await activate(env,email,data);
    if(path==='/api/v1/auth/login'&&request.method==='POST')return await login(env,email,data);
    if(path==='/api/v1/auth/logout'&&request.method==='POST') {
      const s=await session(env,request,email);
      if(s)await env.DB.prepare("UPDATE auth_sessions SET revoked_at=? WHERE session_id_hash=?").bind(now(),s.hash).run();
      return response(200,{ok:true},{'set-cookie':clearCookie()});
    }
  } catch {return error(503,'STAGING_AUTH_BACKEND_UNAVAILABLE');}
  return error(405,'METHOD_NOT_ALLOWED');
}

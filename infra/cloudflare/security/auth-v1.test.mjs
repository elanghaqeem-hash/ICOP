import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAuthV1 } from './auth-v1.mjs';

const origin='https://icop-staging-api.example';
const email='elang.haqeem@gmail.com';
function env(db) {
  return {DB:db, ACCESS_AUD:'test-audience', ACCESS_IDENTITY_ENABLED:'true',
    ACCESS_MFA_CONFIRMED:'true', AUTH_V2_ENABLED:'true',
    AUTH_ACTIVATION_ENABLED:'true', SESSION_HMAC_KEY:'f'.repeat(64)};
}
const access=(emailAddress=email)=>({access:{aud:'test-audience',getIdentity:async()=>({email:emailAddress})}});
function req(path,method='GET',body,headers={}) {
  return new Request(origin+path,{method,headers:{
    ...(body?{'content-type':'application/json',origin}:{}),...headers
  },...(body?{body:JSON.stringify(body)}:{})});
}
function db() {
  const state={tenant:{id:'tenant-1',code:'DEIT'},user:null,sessions:new Map(),audit:[]};
  return {state,prepare(sql) {
    return {bind(...values) {
      return {async first() {
        if(sql.includes('FROM tenants WHERE')) return {id:state.tenant.id};
        if(sql.includes('SELECT u.* FROM users'))return state.user;
        if(sql.includes('FROM auth_sessions s JOIN users')) {
          const item=state.sessions.get(values[0]);
          if(!item || !state.user)return null;
          const u=state.user;
          return {...item,email_normalized:u.email_normalized,email:u.email,
            role:u.role,is_active:u.is_active,mfa_enabled:u.mfa_enabled,
            user_token_version:u.token_version,force_password_change:u.force_password_change};
        }
        throw Error('unexpected first '+sql);
      },async run() {
        if(sql.includes('INSERT OR IGNORE INTO users')) {
          const [id,tenant_id,email,email_normalized,full_name,password_hash,role,is_active,force_password_change,mfa_enabled]=values;
          state.user={id,tenant_id,email,email_normalized,full_name,password_hash,role,
            is_active,force_password_change,mfa_enabled,token_version:0,failed_logins:0,locked_until:null};
          return {success:true,meta:{changes:1}};
        }
        if(sql.includes('UPDATE users SET password_hash')) {
          const [password_hash,tenant_id,mail]=values;
          if(state.user?.tenant_id===tenant_id&&state.user?.email_normalized===mail&&state.user?.is_active===0) {
            Object.assign(state.user,{password_hash,is_active:1,force_password_change:0,mfa_enabled:1,token_version:1});
            return {success:true,meta:{changes:1}};
          }
          return {success:true,meta:{changes:0}};
        }
        if(sql.includes('INSERT INTO audit_events')){state.audit.push(values[2]);return {success:true};}
        if(sql.includes('UPDATE users SET failed_logins=0')){state.user.failed_logins=0;state.user.locked_until=null;return {success:true};}
        if(sql.includes('UPDATE users SET failed_logins=?')){state.user.failed_logins=values[0];return {success:true};}
        if(sql.includes('INSERT INTO auth_sessions')) {
          const [hash,tenant_id,user_id,token_version,mfa_verified,issued_at,expires_at]=values;
          state.sessions.set(hash,{session_id_hash:hash,tenant_id,user_id,token_version,mfa_verified,
            issued_at,expires_at,revoked_at:null});return {success:true};
        }
        if(sql.includes('UPDATE auth_sessions SET revoked_at')) {
          const s=state.sessions.get(values[1]);if(s)s.revoked_at=values[0];return {success:true};
        }
        throw Error('unexpected run '+sql);
      }};
    }};
  }};
}
test('fail-closed by default even when DB exists',async()=>{
  const e=env(db());e.ACCESS_MFA_CONFIRMED='false';
  const r=await handleAuthV1(req('/api/v1/auth/login','POST',{tenant:'DEIT',email,password:'irrelevant'}),e,access());
  assert.equal(r.status,503);
  assert.equal((await r.json()).code,'STAGING_AUTH_GATES_PENDING');
});
test('denies requests without verified Access identity and cross-origin mutations',async()=>{
  const e=env(db()),b={tenant:'DEIT',email,password:'irrelevant'};
  assert.equal((await handleAuthV1(req('/api/v1/auth/login','POST',b),e,{})).status,403);
  assert.equal((await handleAuthV1(req('/api/v1/auth/login','POST',b),e,access('other@example.com'))).status,403);
  const request=req('/api/v1/auth/login','POST',b,{origin:'https://evil.example'});
  assert.equal((await handleAuthV1(request,e,access())).status,403);
});
test('activate once, log in with new password, verify and revoke httpOnly session',async()=>{
  const storage=db(),e=env(storage);
  const password='NewPassphrase#2026_Valid';
  const activated=await handleAuthV1(req('/api/v1/auth/activate','POST',{newPassword:password}),e,access());
  assert.equal(activated.status,200,await activated.text().catch(()=>'')); // this reads only when assertions fail
  assert.equal(storage.state.user?.email,email);
  assert.equal(storage.state.user?.is_active,1);
  assert.match(storage.state.user.password_hash,/^pbkdf2-sha256\$600000\$/);
  assert.equal((await handleAuthV1(req('/api/v1/auth/activate','POST',{newPassword:password}),e,access())).status,409);
  const bad=await handleAuthV1(req('/api/v1/auth/login','POST',{tenant:'DEIT',email,password:'invalid'}),e,access());
  assert.equal(bad.status,401);
  const logged=await handleAuthV1(req('/api/v1/auth/login','POST',{tenant:'DEIT',email,password}),e,access());
  assert.equal(logged.status,200);
  assert.equal((await logged.json()).user.role,'super_admin');
  const c=logged.headers.get('set-cookie');
  assert.match(c,/HttpOnly/);assert.match(c,/Secure/);assert.match(c,/SameSite=Strict/);
  const rawCookie=c.split(';')[0];
  const me=await handleAuthV1(req('/api/v1/auth/me','GET',null,{cookie:rawCookie}),e,access());
  assert.equal(me.status,200);
  const logout=await handleAuthV1(req('/api/v1/auth/logout','POST',{}, {cookie:rawCookie}),e,access());
  assert.equal(logout.status,200);
  const after=await handleAuthV1(req('/api/v1/auth/me','GET',null,{cookie:rawCookie}),e,access());
  assert.equal(after.status,401);
});

test('Access diagnostic requires a runtime-verified identity even with gates closed',async()=>{
  const e=env(db()); e.ACCESS_IDENTITY_ENABLED='false'; e.ACCESS_MFA_CONFIRMED='false';
  const p='/api/v1/auth/access-check';
  const anonymous=await handleAuthV1(req(p),e,{});
  assert.equal(anonymous.status,403);
  assert.equal((await anonymous.json()).code,'CLOUDFLARE_ACCESS_VERIFIED_IDENTITY_REQUIRED');
  const wrong=await handleAuthV1(req(p),e,access('unapproved@example.com'));
  assert.equal(wrong.status,403);
  const matching=await handleAuthV1(req(p),e,access());
  assert.equal(matching.status,200);
  const body=await matching.json();
  assert.equal(body.accessAuthenticated,true);
  assert.equal(body.applicationAuthenticated,false);
  assert.equal(body.activationReady,false);
  assert.equal((await handleAuthV1(req('/activate'),e,{})).status,403);
  assert.equal((await handleAuthV1(req('/activate'),e,access())).status,503);
});

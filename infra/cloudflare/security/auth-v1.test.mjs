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
  return {state,
    async batch(statements) {
      // D1 batch contract: statements are committed atomically.
      const priorUser=state.user?{...state.user}:null,priorAudit=state.audit.slice();
      const priorSessions=new Map(Array.from(state.sessions,([k,v])=>[k,{...v}]));
      const results=[];
      try {
        for(const stmt of statements) results.push(await stmt.run());
        return results;
      } catch(err) {
        state.user=priorUser;
        state.audit.splice(0,state.audit.length,...priorAudit);
        state.sessions=priorSessions;
        throw err;
      }
    },
    prepare(sql) {
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
        if(sql.includes('INSERT INTO users')) {
          const [id,tenant_id,email,email_normalized,full_name,password_hash,role,is_active,force_password_change,mfa_enabled]=values;
          if(state.user)throw Error('UNIQUE constraint failed: users.tenant_id, users.email_normalized');
          if(typeof password_hash!=='string'||password_hash.length<50)
            throw Error('CHECK constraint failed: length(password_hash) >= 50');
          state.user={id,tenant_id,email,email_normalized,full_name,password_hash,role,
            is_active,force_password_change,mfa_enabled,token_version:0,failed_logins:0,locked_until:null};
          return {success:true,meta:{changes:1}};
        }
        if(sql.includes('UPDATE users SET password_hash=')) {
          const [password_hash,user_id,tenant_id,mail,version]=values;
          if(state.user?.id!==user_id||state.user?.tenant_id!==tenant_id||state.user?.email_normalized!==mail||state.user?.token_version!==version||state.user?.force_password_change!==1){state.lastChanges=0;return {success:true,meta:{changes:0}};}
          Object.assign(state.user,{password_hash,force_password_change:0,token_version:version+1,failed_logins:0,locked_until:null});
          state.lastChanges=1;
          return {success:true,meta:{changes:1}};
        }
        if(sql.includes('INSERT INTO audit_events')){
          if(state.failAudit)throw Error('INJECTED_AUDIT_FAILURE');
          if(sql.includes('WHERE changes()=1')&&state.lastChanges!==1) {state.lastChanges=0;return {success:true,meta:{changes:0}};}
          state.audit.push(values[2]);state.lastChanges=1;return {success:true,meta:{changes:1}};
        }
        if(sql.includes('UPDATE users SET failed_logins=0')){state.user.failed_logins=0;state.user.locked_until=null;return {success:true};}
        if(sql.includes('UPDATE users SET failed_logins=?')){state.user.failed_logins=values[0];return {success:true};}
        if(sql.includes('INSERT INTO auth_sessions')) {
          const [hash,tenant_id,user_id,token_version,mfa_verified,issued_at,expires_at]=values;
          state.sessions.set(hash,{session_id_hash:hash,tenant_id,user_id,token_version,mfa_verified,
            issued_at,expires_at,revoked_at:null});return {success:true};
        }
        if(sql.includes('UPDATE auth_sessions SET revoked_at')) {
          if(sql.includes('tenant_id=?')){
            let changes=0;
            for(const session of state.sessions.values()){
              if(session.tenant_id===values[1]&&session.user_id===values[2]&&session.revoked_at===null){session.revoked_at=values[0];changes++;}
            }
            return {success:true,meta:{changes}};
          }
          const item=state.sessions.get(values[1]);if(item)item.revoked_at=values[0];return {success:true};
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
  assert.match(storage.state.user.password_hash,/^pbkdf2-sha256-chain-v1\$100000x6\$/);
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

function formPost(path, fields, headers={}) {
  return new Request(origin+path,{
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',...headers},
    body:new URLSearchParams(fields).toString()
  });
}
async function issueForm(path,storage) {
  const page=await handleAuthV1(req(path),storage,access());
  assert.equal(page.status,200);
  const body=await page.text();
  const token=body.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  assert.match(token,/^v2\.[0-9]{10}\.[a-f0-9]{48}\.[a-f0-9]{64}$/);
  assert.equal(page.headers.get('set-cookie'),null,'no third-party-incompatible CSRF cookie is required');
  return token;
}
test('mobile Origin-less form activates once without CSRF cookies, with verified Access MFA',async()=>{
  const storage=db(),e=env(storage),password='VeryUnique#2026_Administrator';
  const token=await issueForm('/activate',e);
  const ok=await handleAuthV1(formPost('/api/v1/auth/activate',
    {newPassword:password,csrf_token:token},{'sec-fetch-site':'same-origin'}),e,access());
  assert.equal(ok.status,200,await ok.clone().text());
  assert.equal((await ok.json()).status,'activated');
  assert.equal(storage.state.user?.email,email);
  assert.equal(storage.state.user?.role,'super_admin');
  assert.equal(storage.state.user?.is_active,1);
  assert.match(storage.state.user?.password_hash,/^pbkdf2-sha256-chain-v1\$100000x6\$/);
  const another=await handleAuthV1(formPost('/api/v1/auth/activate',
    {newPassword:password,csrf_token:token}),e,access());
  assert.equal(another.status,409,'one-time provisioning cannot create a duplicate');
  const loginToken=await issueForm('/login',e);
  const login=await handleAuthV1(formPost('/api/v1/auth/login',
    {email,tenant:'DEIT',password,csrf_token:loginToken},{origin:'null','sec-fetch-site':'same-origin'}),e,access());
  assert.equal(login.status,200);
  assert.equal((await login.json()).applicationAuthenticated,true);
});
test('opaque Origin null from mobile browser accepted only with signed identity-bound form token',async()=>{
  const storage=db(),e=env(storage),token=await issueForm('/activate',e);
  const x=await handleAuthV1(formPost('/api/v1/auth/activate',
    {newPassword:'New_Valid#Activation2026',csrf_token:token},{origin:'null','sec-fetch-site':'same-origin'}),e,access());
  assert.equal(x.status,200);
});
test('CSRF token is mandatory even with matching Origin on a native HTML form',async()=>{
  const storage=db(),e=env(storage),pw='New_Valid#Activation2026';
  const x=await handleAuthV1(formPost('/api/v1/auth/activate',
    {newPassword:pw},{origin}),e,access());
  assert.equal(x.status,403);
  assert.equal((await x.json()).code,'ORIGIN_REQUIRED');
  assert.equal(storage.state.user,null);
});
test('signed forms deny cross-site Origin, Fetch Metadata, Referer, tampering, wrong action and expired token',async()=>{
  const storage=db(),e=env(storage),pw='New_Valid#Activation2026';
  const token=await issueForm('/activate',e);
  const submit=(csrf,headers={})=>handleAuthV1(
    formPost('/api/v1/auth/activate',{newPassword:pw,csrf_token:csrf},headers),e,access()
  );
  assert.equal((await submit('')).status,403);
  assert.equal((await submit(token.slice(0,-1)+(token.endsWith('f')?'e':'f'))).status,403);
  assert.equal((await submit(token,{origin:'https://evil.example'})).status,403);
  assert.equal((await submit(token,{'sec-fetch-site':'cross-site'})).status,403);
  assert.equal((await submit(token,{referer:'https://evil.example/form'})).status,403);
  const loginToken=await issueForm('/login',e);
  assert.equal((await submit(loginToken)).status,403,'token is action-scoped');
  const originalDateNow=Date.now;
  try {
    Date.now=()=>originalDateNow()+11*60*1000;
    assert.equal((await submit(token)).status,403,'token expires after 10 minutes');
  } finally {Date.now=originalDateNow;}
  assert.equal(storage.state.user,null);
});
test('JSON API does not accept Origin null or absent even with Access verified',async()=>{
  const e=env(db());
  const b={tenant:'DEIT',email,password:'unused'};
  assert.equal((await handleAuthV1(req('/api/v1/auth/login','POST',b,{origin:'null'}),e,access())).status,403);
  const noOrigin=new Request(origin+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
  assert.equal((await handleAuthV1(noOrigin,e,access())).status,403);
});

test('activation batch rolls back the user when D1 audit insertion fails',async()=>{
  const store=db(),e=env(store);
  store.state.failAudit=true;
  const res=await handleAuthV1(req('/api/v1/auth/activate','POST',
    {newPassword:'Unique#2026_RecoveryPass'}),e,access());
  assert.equal(res.status,503);
  assert.equal(store.state.user,null,'no partially activated user after failed audit');
  assert.deepEqual(store.state.audit,[]);
});
test('password hash respects D1 CHECK length and no pending placeholder is stored',async()=>{
  const store=db(),e=env(store);
  const res=await handleAuthV1(req('/api/v1/auth/activate','POST',
    {newPassword:'Unique#2026_RecoveryPass'}),e,access());
  assert.equal(res.status,200);
  assert.ok(store.state.user.password_hash.length>=50);
  assert.match(store.state.user.password_hash,/^pbkdf2-sha256-chain-v1\$100000x6\$/);
  assert.equal(store.state.audit.length,1);
});

test('existing super-admin password reset is one-time and revokes old sessions', async()=>{
  const storage=db(),e=env(storage),oldPass='OldPassword#2026_Retire',nextPass='FreshPassword#2026_Change';
  const activated=await handleAuthV1(req('/api/v1/auth/activate','POST',{newPassword:oldPass}),e,access());
  assert.equal(activated.status,200);
  const oldLogin=await handleAuthV1(req('/api/v1/auth/login','POST',{tenant:'DEIT',email,password:oldPass}),e,access());
  assert.equal(oldLogin.status,200);
  const oldCookie=oldLogin.headers.get('set-cookie').split(';')[0];
  const id=storage.state.user.id, priorVersion=storage.state.user.token_version;
  assert.equal((await handleAuthV1(req('/reset-password'),e,access())).status,409);
  storage.state.user.force_password_change=1;
  const token=await issueForm('/reset-password',e);
  const reset=await handleAuthV1(formPost('/api/v1/auth/reset-password',{
    csrf_token:token,newPassword:nextPass,confirmPassword:nextPass
  },{origin:'null'}),e,access());
  assert.equal(reset.status,200,await reset.clone().text());
  assert.equal((await reset.json()).status,'password_reset');
  assert.equal(storage.state.user.id,id);
  assert.equal(storage.state.user.force_password_change,0);
  assert.equal(storage.state.user.token_version,priorVersion+1);
  assert.equal(storage.state.audit.at(-1),'auth.admin_password_reset_access_mfa');
  assert.ok(Array.from(storage.state.sessions.values()).every(x=>x.revoked_at!==null));
  assert.equal((await handleAuthV1(req('/api/v1/auth/me','GET',null,{cookie:oldCookie}),e,access())).status,401);
  assert.equal((await handleAuthV1(req('/api/v1/auth/login','POST',{tenant:'DEIT',email,password:oldPass}),e,access())).status,401);
  assert.equal((await handleAuthV1(req('/api/v1/auth/login','POST',{tenant:'DEIT',email,password:nextPass}),e,access())).status,200);
  assert.equal((await handleAuthV1(req('/reset-password'),e,access())).status,409);
});
test('reset refuses mismatched password, wrong Access identity or forged CSRF',async()=>{
  const storage=db(),e=env(storage),pw='OldValidPassword#2026';
  assert.equal((await handleAuthV1(req('/api/v1/auth/activate','POST',{newPassword:pw}),e,access())).status,200);
  storage.state.user.force_password_change=1;
  const token=await issueForm('/reset-password',e);
  const mismatch=formPost('/api/v1/auth/reset-password',{csrf_token:token,newPassword:'NewValidPassword#2026',confirmPassword:'Mismatch#2026_Wrong'});
  assert.equal((await handleAuthV1(mismatch,e,access())).status,400);
  assert.equal((await handleAuthV1(formPost('/api/v1/auth/reset-password',{
    csrf_token:token,newPassword:'NewValidPassword#2026',confirmPassword:'NewValidPassword#2026'
  }),e,access('unauthorized@example.com'))).status,403);
  assert.equal((await handleAuthV1(formPost('/api/v1/auth/reset-password',{
    csrf_token:'tampered',newPassword:'NewValidPassword#2026',confirmPassword:'NewValidPassword#2026'
  }),e,access())).status,403);
  assert.equal(storage.state.user.force_password_change,1);
});
test('D1 error during reset audit rolls back password update',async()=>{
  const storage=db(),e=env(storage),oldPass='OriginalPassword#2026';
  assert.equal((await handleAuthV1(req('/api/v1/auth/activate','POST',{newPassword:oldPass}),e,access())).status,200);
  storage.state.user.force_password_change=1;
  const oldHash=storage.state.user.password_hash;
  const oldVersion=storage.state.user.token_version;
  storage.state.failAudit=true;
  const token=await issueForm('/reset-password',e);
  const r=await handleAuthV1(formPost('/api/v1/auth/reset-password',{
    csrf_token:token,newPassword:'NewPassword#2026_Changed',confirmPassword:'NewPassword#2026_Changed'
  }),e,access());
  assert.equal(r.status,503);
  assert.equal(storage.state.user.password_hash,oldHash);
  assert.equal(storage.state.user.token_version,oldVersion);
  assert.equal(storage.state.user.force_password_change,1);
});

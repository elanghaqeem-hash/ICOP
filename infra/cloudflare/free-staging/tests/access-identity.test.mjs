import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const ORIGIN = 'https://icop-staging-api.example.invalid';
const FLAGS = { ACCESS_IDENTITY_ENABLED: 'true', ACCESS_MFA_CONFIRMED: 'true', ACCESS_AUD: 'staging-access-app', ACCESS_AUDIT_HMAC_KEY: '1a'.repeat(32) };
const PROFILE = {
  id: 'synthetic-1', tenant_id: 'tenant-deit', email_normalized: 'test@example.invalid',
  full_name: 'Synthetic Identity', code: 'DEIT', role: 'auditor',
  is_active: 1, force_password_change: 1, mfa_enabled: 0,
};

function fakeDb({ user = PROFILE, auditFail = false, schemaPresent = true } = {}) {
  const calls = [];
  const DB = { prepare(sql) {
    return { bind(...params) {
      calls.push({ sql, params });
      return {
        async first() {
          if (sql.includes('migration_history')) {
            return schemaPresent ? {version: params[0]} : null;
          }
          if (sql.includes('FROM users u')) {
            return params[0] === 'DEIT' && params[1] === 'test@example.invalid'
              ? user : null;
          }
          return null;
        },
        async run() {
          if (auditFail) throw new Error('do not reveal database errors');
          return { success: true };
        },
      };
    }};
  }};
  return { DB, calls };
}
const access = (email='test@example.invalid', aud='staging-access-app') => ({
  access: { aud, getIdentity: async () => ({ email }) },
});
const request = (tenant='DEIT', extra = {}) => new Request(ORIGIN+'/api/v1/auth/access-me', {
  headers: { 'x-icop-tenant': tenant, ...extra },
});
const api = async (req, env, ctx) => {
  const r = await worker.fetch(req, env, ctx);
  return { status: r.status, data: await r.json(), headers: r.headers };
};

test('disabled by default even when a synthetic identity and D1 user are supplied',async()=>{
  const {DB}=fakeDb();
  const r=await api(request(), {DB}, access());
  assert.equal(r.status,503);
  assert.equal(r.data.code,'STAGING_ACCESS_NOT_CONFIGURED');
});
test('Access membership alone cannot activate identity lookup without confirmed MFA gate',async()=>{
  const {DB,calls}=fakeDb();
  for (const flag of [undefined, 'false', 'TRUE']) {
    const env={...FLAGS,ACCESS_MFA_CONFIRMED:flag,DB};
    const r=await api(request('DEIT',{'cf-connecting-ip':'192.0.2.44'}),env,access());
    assert.equal(r.status,503);
    assert.equal(r.data.code,'STAGING_MFA_GATE_PENDING');
  }
  assert.equal(calls.some(x=>x.sql.includes('FROM users u')),false);
  assert.equal(calls.some(x=>x.sql.includes('INSERT INTO audit_events')),false);
});

test('raw JWT, email and role headers cannot substitute native ctx.access',async()=>{
  const {DB}=fakeDb();
  const r=await api(request('DEIT',{
    'cf-access-jwt-assertion':'forged',
    'x-user-email':'test@example.invalid',
    'x-user-role':'super_admin',
  }), {...FLAGS,DB});
  assert.equal(r.status,403);
  assert.equal(r.data.code,'ACCESS_REQUIRED');
});
test('audience mismatch and identity validation fail closed',async()=>{
  const {DB}=fakeDb();
  const wrong=await api(request(), {...FLAGS,DB}, access(undefined,'wrong-access-app'));
  assert.equal(wrong.status,403);
  const empty=await api(request(), {...FLAGS,DB}, access('not-an-email'));
  assert.equal(empty.status,403);
});
test('tenant must be explicit, well formed, and mapped to identity',async()=>{
  const {DB}=fakeDb();
  const invalid=await api(request('acme/../'), {...FLAGS,DB}, access());
  assert.equal(invalid.status,400);
  const cross=await api(request('OTHER'), {...FLAGS,DB}, access());
  assert.equal(cross.status,403);
  assert.equal(cross.data.code,'ACCESS_MEMBERSHIP_DENIED');
});
test('inactive users, unknown roles and absent user are denied',async()=>{
  for (const user of [null, {...PROFILE,is_active:0}, {...PROFILE,role:'root'}]) {
    const {DB}=fakeDb({user});
    const r=await api(request(),{...FLAGS,DB},access());
    assert.equal(r.status,403);
    assert.equal(r.data.code,'ACCESS_MEMBERSHIP_DENIED');
  }
});
test('trusted Access identity returns pending-only status and writes tenant-scoped audit',async()=>{
  const {DB,calls}=fakeDb();
  const r=await api(request('DEIT',{'cf-connecting-ip':'192.0.2.44'}),{...FLAGS,DB},access());
  assert.equal(r.status,202);
  assert.equal(r.data.status,'identity_verified_application_auth_pending');
  assert.equal(r.data.tenant.code,'DEIT');
  assert.equal('user' in r.data,false, 'pre-session identity must not expose name/role/user ID');
  assert.equal('user' in r.data,false, 'pre-session identity must not expose name/role/user ID');
  assert.equal(r.data.applicationAuthenticated,false);
  assert.equal(r.data.mfaVerified,false);
  assert.deepEqual(r.data.permissions,[]);
  assert.equal('token' in r.data,false);
  assert.equal('password_hash' in r.data,false);
  const audit=calls.find(c=>c.sql.includes('INSERT INTO audit_events'));
  assert.deepEqual(audit.params.slice(0,3),['tenant-deit','synthetic-1','synthetic-1']);
  assert.match(audit.params[3],/^hmac-sha256:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(audit.params).includes('192.0.2.44'), 'raw source IP must not be persisted');
  assert.equal(r.headers.get('cache-control'),'no-store');
});
test('audit write failure denies identity resolution; do not silently ignore',async()=>{
  const {DB}=fakeDb({auditFail:true});
  const r=await api(request('DEIT',{'cf-connecting-ip':'2001:db8::1'}),{...FLAGS,DB},access());
  assert.equal(r.status,503);
  assert.equal(r.data.code,'STAGING_AUDIT_UNAVAILABLE');
  assert.equal(JSON.stringify(r.data).includes('do not reveal'),false);
});
test('access-me does not activate legacy login, MFA or any business endpoint',async()=>{
  const {DB}=fakeDb();
  const login=await api(new Request(ORIGIN+'/api/v1/auth/login',{method:'POST'}),{...FLAGS,DB},access());
  assert.equal(login.status,503);
  assert.equal(login.data.code,'STAGING_AUTH_NOT_READY');
  const business=await api(new Request(ORIGIN+'/api/v1/pricing/calculate'),{...FLAGS,DB},access());
  assert.equal(business.status,503);
  const readiness=await api(new Request(ORIGIN+'/api/v1/system/readiness'),{...FLAGS,DB},access());
  assert.ok(Object.values(readiness.data.capabilities).every(v=>v===false));
});

test('no audit HMAC secret or missing trusted IP cannot yield a success',async()=>{
  const {DB,calls}=fakeDb();
  const noKey=await api(request('DEIT',{'cf-connecting-ip':'192.0.2.44'}),
    {...FLAGS,ACCESS_AUDIT_HMAC_KEY:undefined,DB},access());
  assert.equal(noKey.status,503);
  assert.equal(noKey.data.code,'STAGING_AUDIT_NOT_CONFIGURED');
  const noIp=await api(request(),{...FLAGS,DB},access());
  assert.equal(noIp.status,503);
  assert.equal(noIp.data.code,'STAGING_AUDIT_NOT_CONFIGURED');
  assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO audit_events')).length,0);
});
test('empty or malformed audit result cannot authorize identity',async()=>{
  const {DB}=fakeDb();
  const originalPrepare=DB.prepare;
  DB.prepare=(sql)=>{
    const q=originalPrepare(sql);
    if(sql.includes('INSERT INTO audit_events')) {
      return {bind:()=>({run:async()=>({success:false})})};
    }
    return q;
  };
  const r=await api(request('DEIT',{'cf-connecting-ip':'192.0.2.44'}),
    {...FLAGS,DB},access());
  assert.equal(r.status,503);
  assert.equal(r.data.code,'STAGING_AUDIT_UNAVAILABLE');
});


test('DEIT controlled gate: live-safe flags reject synthetic verified member before D1 lookup',async()=>{
  const {DB,calls}=fakeDb();
  const r=await api(request('DEIT',{'cf-connecting-ip':'192.0.2.44'}),{
    ...FLAGS,ACCESS_IDENTITY_ENABLED:'false',ACCESS_MFA_CONFIRMED:'false',DB,
  },access());
  assert.equal(r.status,503);
  assert.equal(r.data.code,'STAGING_ACCESS_NOT_CONFIGURED');
  assert.ok(!calls.some(x=>x.sql.includes('FROM users u')));
  assert.ok(!calls.some(x=>x.sql.includes('INSERT INTO audit_events')));
});

test('DEIT controlled identity: membership is tenant+email scoped and yields no app session',async()=>{
  const {DB,calls}=fakeDb();
  const r=await api(request('DEIT',{'cf-connecting-ip':'192.0.2.44'}),
    {...FLAGS,DB},access(' TEST@EXAMPLE.INVALID '));
  assert.equal(r.status,202);
  const lookup=calls.find(x=>x.sql.includes('FROM users u'));
  assert.deepEqual(lookup.params,['DEIT','test@example.invalid']);
  assert.equal(r.data.tenant.code,'DEIT');
  assert.equal(r.data.applicationAuthenticated,false);
  assert.equal(r.data.mfaVerified,false);
  assert.deepEqual(r.data.permissions,[]);
  for(const forbidden of ['token','session','role','userId','full_name','password_hash']){
    assert.ok(!(forbidden in r.data),forbidden+' must not be released before ICOP login');
  }
});

test('DEIT controlled identity: forged role/email headers cannot override Cloudflare verified email',async()=>{
  const {DB,calls}=fakeDb();
  const r=await api(request('DEIT',{
    'cf-connecting-ip':'192.0.2.44',
    'x-user-email':'test@example.invalid','x-user-role':'super_admin',
  }),{...FLAGS,DB},access('intruder@example.invalid'));
  assert.equal(r.status,403);
  assert.equal(r.data.code,'ACCESS_MEMBERSHIP_DENIED');
  assert.deepEqual(calls.find(x=>x.sql.includes('FROM users u')).params,
    ['DEIT','intruder@example.invalid']);
  assert.ok(!calls.some(x=>x.sql.includes('INSERT INTO audit_events')));
});

test('DEIT controlled identity: cross-tenant and inactive membership never create audit',async()=>{
  for(const {tenant,user} of [
    {tenant:'OTHER',user:PROFILE},
    {tenant:'DEIT',user:{...PROFILE,is_active:0}},
    {tenant:'DEIT',user:{...PROFILE,role:'undefined-role'}},
  ]){
    const {DB,calls}=fakeDb({user});
    const r=await api(request(tenant,{'cf-connecting-ip':'192.0.2.44'}),
      {...FLAGS,DB},access());
    assert.equal(r.status,403);
    assert.equal(r.data.code,'ACCESS_MEMBERSHIP_DENIED');
    assert.ok(!calls.some(x=>x.sql.includes('INSERT INTO audit_events')));
  }
});

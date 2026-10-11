import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const ORIGIN = 'https://icop-staging-api.example.invalid';
const FLAGS = { ACCESS_IDENTITY_ENABLED: 'true', ACCESS_AUD: 'staging-access-app' };
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
  assert.equal(r.data.user.role,'auditor');
  assert.equal(r.data.user.forcePasswordChange,true);
  assert.equal(r.data.applicationAuthenticated,false);
  assert.equal(r.data.mfaVerified,false);
  assert.deepEqual(r.data.permissions,[]);
  assert.equal('token' in r.data,false);
  assert.equal('password_hash' in r.data,false);
  const audit=calls.find(c=>c.sql.includes('INSERT INTO audit_events'));
  assert.deepEqual(audit.params,['tenant-deit','synthetic-1','synthetic-1','192.0.2.44']);
  assert.equal(r.headers.get('cache-control'),'no-store');
});
test('audit write failure denies identity resolution; do not silently ignore',async()=>{
  const {DB}=fakeDb({auditFail:true});
  const r=await api(request(),{...FLAGS,DB},access());
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

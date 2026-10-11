import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../src/worker.mjs';

const url = (p) => new Request('https://icop-staging-api.example.invalid' + p);
const db = {
  prepare: () => ({
    bind: () => ({
      first: async () => ({ version: '0001_cf_free_staging_bootstrap' }),
    }),
  }),
};
const json = async (r) => ({status:r.status,data:await r.json(),headers:r.headers});

test('health requires D1 migration', async () => {
  const missing = await json(await api.fetch(url('/health'), {}));
  assert.equal(missing.status,503);
  assert.equal(missing.data.code,'STAGING_DB_NOT_READY');
  const ok = await json(await api.fetch(url('/health'),{DB:db}));
  assert.equal(ok.status,200);
  assert.equal(ok.data.database,'ready');
  assert.equal(ok.headers.get('cache-control'),'no-store');
});
test('capability manifest never claims production readiness',async () => {
  const r = await json(await api.fetch(url('/api/v1/system/readiness'), {DB:db}));
  assert.equal(r.status,200);
  assert.equal(r.data.status,'bootstrap_only');
  assert.ok(Object.values(r.data.capabilities).every(x=>x===false));
  assert.equal(r.data.schema.identity_audit_prepared,false);
  assert.equal(r.data.schema.auth_security_prepared,false);
});

test('identity/audit schema presence never unlocks auth or business modules', async () => {
  const identityDb = {
    prepare: () => ({
      bind: (version) => ({
        first: async () => ({version}),
      }),
    }),
  };
  const r = await json(await api.fetch(url('/api/v1/system/readiness'),{DB:identityDb}));
  assert.equal(r.status,200);
  assert.equal(r.data.schema.identity_audit_prepared,true);
  assert.equal(r.data.schema.auth_security_prepared,false);
  assert.ok(Object.values(r.data.capabilities).every(x=>x===false));
  const login = await json(await api.fetch(new Request(
    'https://icop-staging-api.example.invalid/api/v1/auth/login', {method:'POST'}
  ), {DB:identityDb}));
  assert.equal(login.status,503);
  assert.equal(login.data.code,'STAGING_AUTH_NOT_READY');
});
test('login and unported modules fail closed without user provisioning',async ()=>{
  const l=await json(await api.fetch(new Request('https://icop-staging-api.example.invalid/api/v1/auth/login',{method:'POST',body:'{"password":"should-not-be-read"}'}),{DB:db}));
  assert.equal(l.status,503);
  assert.equal(l.data.code,'STAGING_AUTH_NOT_READY');
  assert.equal(JSON.stringify(l.data).includes('should-not-be-read'),false);
  const m=await json(await api.fetch(url('/api/v1/crm/customers'),{DB:db}));
  assert.equal(m.status,503);
  assert.equal(m.data.code,'MODULE_NOT_MIGRATED');
});

test('DDL 0003 alone never authorizes authentication',async () => {
  const schemaDb = {
    prepare: () => ({ bind: (version) => ({ first: async () => ({version}) }) }),
  };
  const r = await json(await api.fetch(url('/api/v1/system/readiness'), {DB:schemaDb}));
  assert.equal(r.status,200);
  assert.equal(r.data.schema.auth_security_prepared,true);
  assert.equal(r.data.capabilities.authentication,false);
  assert.equal(r.data.capabilities.mfa,false);
});

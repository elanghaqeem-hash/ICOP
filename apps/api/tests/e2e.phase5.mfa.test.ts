import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { totpAt, matchTotp } from '../src/modules/auth/totp.js';
import { SEED_PW, NEW_PW, freshDb, makeApp, api } from './helpers.js';

let sql: Sql;
let app: FastifyInstance;
let pendingToken: string;
let enrolledToken: string;
let secret: string;
let customerId: string;
const previousPolicy = process.env.MFA_POLICY;

beforeAll(async () => {
  process.env.MFA_POLICY = 'privileged';
  sql = await freshDb();
  app = await makeApp(sql);
});
afterAll(async () => {
  if (app) await app.close();
  if (sql) await sql.end();
  if (previousPolicy === undefined) delete process.env.MFA_POLICY;
  else process.env.MFA_POLICY = previousPolicy;
});

describe('Phase 5 Gate 4B: privileged MFA, anti-replay, tenant access', () => {
  it('matches the RFC6238 SHA-1 reference code', () => {
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpAt(rfcSecret, 1)).toBe('287082'); // 59 seconds, SHA-1 TOTP truncated to 6 digits
    expect(matchTotp(rfcSecret, '287082', -1, 59_000)).toBe(1);
    expect(matchTotp(rfcSecret, '287082', 1, 59_000)).toBe(null);
  });

  it('requires first-password change, then MFA setup before business access', async () => {
    let r = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'companyadmin@defendit360.com', password: SEED_PW } });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.forcePasswordChange).toBe(true);
    expect((await api(app, r.json().token).get('/api/v1/customers')).body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    r = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password',
      headers: { authorization: 'Bearer ' + r.json().token },
      payload: { currentPassword: SEED_PW, newPassword: NEW_PW } });
    expect(r.statusCode).toBe(200);
    expect(r.json().mfaRequired).toBe(true);
    expect(r.json().mfaEnrolled).toBe(false);
    pendingToken = r.json().token;
    const blocked = await api(app, pendingToken).get('/api/v1/customers');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_REQUIRED');
    const me = await api(app, pendingToken).get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.mfaRequired).toBe(true);
    expect(me.body.permissions).toEqual([]);
  });

  it('stores enrollment secret encrypted, denies wrong codes and activates only after TOTP', async () => {
    const p = api(app, pendingToken);
    let r = await p.post('/api/v1/auth/mfa/setup', {});
    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(r.body.otpauthUri).toContain('otpauth://totp/');
    secret = r.body.secret;
    const [row] = await sql`SELECT mfa_pending_secret_enc, mfa_enabled FROM users WHERE email = 'companyadmin@defendit360.com'`;
    expect(row.mfaPendingSecretEnc).toMatch(/^v1:/);
    expect(row.mfaPendingSecretEnc).not.toContain(secret);
    expect(row.mfaEnabled).toBe(false);
    expect((await p.get('/api/v1/customers')).status).toBe(403);

    const nowStep = Math.floor(Date.now() / 30000);
    const bad = totpAt(secret, nowStep) === '000000' ? '111111' : '000000';
    r = await p.post('/api/v1/auth/mfa/enable', { code: bad });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('INVALID_MFA_CODE');
    r = await p.post('/api/v1/auth/mfa/enable', { code: totpAt(secret, Math.floor(Date.now() / 30000)) });
    expect(r.status).toBe(200);
    expect(r.body.mfaRequired).toBe(false);
    enrolledToken = r.body.token;
    expect((await api(app, pendingToken).get('/api/v1/customers')).status).toBe(401);
    expect((await api(app, enrolledToken).get('/api/v1/customers')).status).toBe(200);
  });

  it('requires new TOTP on subsequent login and rejects used codes', async () => {
    const newLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'companyadmin@defendit360.com', password: NEW_PW } });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json().mfaRequired).toBe(true);
    expect(newLogin.json().mfaEnrolled).toBe(true);
    const pending = api(app, newLogin.json().token);
    expect((await pending.get('/api/v1/customers')).body.code).toBe('MFA_REQUIRED');
    const [row] = await sql`SELECT mfa_last_step FROM users WHERE email = 'companyadmin@defendit360.com'`;
    expect((await pending.post('/api/v1/auth/mfa/verify', { code: totpAt(secret, Number(row.mfaLastStep)) })).status).toBe(403);

    // Use the next step (within allowed +/-1 window) to avoid sleeping.
    const step = Math.max(Math.floor(Date.now() / 30000), Number(row.mfaLastStep) + 1);
    const r = await pending.post('/api/v1/auth/mfa/verify', { code: totpAt(secret, step) });
    expect(r.status).toBe(200);
    expect((await api(app, r.body.token).get('/api/v1/customers')).status).toBe(200);
    const replay = await pending.post('/api/v1/auth/mfa/verify', { code: totpAt(secret, step) });
    expect(replay.status).toBe(403);
  });

  it('separates identical customer identifiers across tenants', async () => {
    const c = await api(app, enrolledToken).post('/api/v1/customers',
      { legalName: 'PT Isolasi Pelanggan Gate4B', industry: 'banking' });
    expect(c.status).toBe(201);
    customerId = c.body.id;
    const [tenant] = await sql`INSERT INTO tenants (code, name) VALUES ('G4B', 'Independent Test Tenant') RETURNING id`;
    const passwordHash = await bcrypt.hash(NEW_PW, 12);
    await sql`INSERT INTO users (tenant_id, email, full_name, password_hash, role, force_password_change)
      VALUES (${tenant.id}, 'other-tenant@icop.invalid', 'Other Tenant User', ${passwordHash}, 'account_manager', false)`;
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { tenant: 'G4B', email: 'other-tenant@icop.invalid', password: NEW_PW } });
    expect(r.statusCode).toBe(200);
    expect(r.json().mfaRequired).toBe(false);
    const other = api(app, r.json().token);
    expect((await other.get(`/api/v1/customers/${customerId}`)).status).toBe(404);
    expect((await other.get('/api/v1/customers')).body.items).toEqual([]);
  });

  it('revokes all sessions on logout-all, including verified MFA tokens', async () => {
    const out = await api(app, enrolledToken).post('/api/v1/auth/logout-all');
    expect(out.status).toBe(200);
    expect((await api(app, enrolledToken).get('/api/v1/customers')).status).toBe(401);
  });
  it('rate-limits invalid TOTP and locks repeated attempts without leaking secret', async () => {
    // Separate this lockout assertion from the expected invalid replay attempt in
    // the prior test; every case starts with a clean local failure counter.
    await sql`UPDATE users SET mfa_failed_attempts = 0, mfa_locked_until = NULL
      WHERE email = 'companyadmin@defendit360.com'`;
    const challenge = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'companyadmin@defendit360.com', password: NEW_PW } });
    expect(challenge.statusCode).toBe(200);
    const caller = api(app, challenge.json().token);
    const currentStep = Math.floor(Date.now() / 30000);
    const valid = new Set([-1, 0, 1].map((delta) => totpAt(secret, currentStep + delta)));
    const bad = ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c))!;
    for (let i = 1; i <= 5; i++) {
      const result = await caller.post('/api/v1/auth/mfa/verify', { code: bad });
      expect(result.status).toBe(i === 5 ? 423 : 403);
    }
    const correct = await caller.post('/api/v1/auth/mfa/verify',
      { code: totpAt(secret, currentStep + 1) });
    expect(correct.status).toBe(423);
    const [u] = await sql`SELECT mfa_failed_attempts, mfa_locked_until, mfa_secret_enc FROM users
      WHERE email = 'companyadmin@defendit360.com'`;
    expect(u.mfaFailedAttempts).toBe(5);
    expect(u.mfaLockedUntil).not.toBeNull();
    expect(u.mfaSecretEnc).toMatch(/^v1:/);
    expect(u.mfaSecretEnc).not.toContain(secret);
  });

});

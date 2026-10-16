import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../src/db.js';
import { api, freshDb, login, makeApp, NEW_PW } from './helpers.js';
import { totpAt } from '../src/modules/auth/totp.js';

let sql: Sql;
let app: FastifyInstance;
let a: ReturnType<typeof api>;
let b: ReturnType<typeof api>;
let target: ReturnType<typeof api>;
let targetId = '';
let requestId = '';
const priorPolicy = process.env.MFA_POLICY;

async function enroll(email: string) {
  const challenge = await login(app, email);
  const start = await api(app, challenge).post('/api/v1/auth/mfa/setup', {});
  if (start.status !== 200) throw new Error('setup '+email+' '+JSON.stringify(start.body));
  const confirmation = await api(app, challenge).post('/api/v1/auth/mfa/enable',
    { code: totpAt(start.body.secret, Math.floor(Date.now() / 30000)) });
  if (confirmation.status !== 200) throw new Error('enable '+email+' '+JSON.stringify(confirmation.body));
  return api(app, confirmation.body.token);
}

beforeAll(async () => {
  process.env.MFA_POLICY = 'privileged';
  sql = await freshDb();
  app = await makeApp(sql);
  a = await enroll('companyadmin@defendit360.com');
  b = await enroll('elang.haqeem@gmail.com');
  target = await enroll('salesmanager@defendit360.com');
  const me = await target.get('/api/v1/auth/me');
  targetId = me.body.id;
}, 60000);
afterAll(async () => {
  if (app) await app.close();
  if (sql) await sql.end();
  if (priorPolicy === undefined) delete process.env.MFA_POLICY;
  else process.env.MFA_POLICY = priorPolicy;
});

describe('Phase 5 Gate 4C: two-person MFA recovery', () => {
  it('rejects self-recovery, missing users, and insufficient reasons', async () => {
    const me = await a.get('/api/v1/auth/me');
    const own = await a.post('/api/v1/auth/mfa/recovery-requests',
      { targetUserId: me.body.id, reason: 'Lost authenticator device and need verified recovery' });
    expect(own.status).toBe(403);
    const missing = await a.post('/api/v1/auth/mfa/recovery-requests',
      { targetUserId: '00000000-0000-4000-8000-000000000001',
        reason: 'Account belongs to another tenant and cannot be recovered' });
    expect(missing.status).toBe(404);
    const short = await a.post('/api/v1/auth/mfa/recovery-requests',
      { targetUserId: targetId, reason: 'Lost' });
    expect(short.status).toBe(400);
  });

  it('creates a time-boxed recovery request without changing target account', async () => {
    const result = await a.post('/api/v1/auth/mfa/recovery-requests',
      { targetUserId: targetId, reason: 'Lost authenticator phone, identity verified outside the system' });
    expect(result.status).toBe(201);
    expect(result.body.status).toBe('PENDING');
    requestId = result.body.id;
    const [targetRow] = await sql`SELECT mfa_enabled, force_password_change
      FROM users WHERE id = ${targetId}`;
    expect(targetRow.mfaEnabled).toBe(true);
    expect(targetRow.forcePasswordChange).toBe(false);
    const duplicate = await a.post('/api/v1/auth/mfa/recovery-requests',
      { targetUserId: targetId, reason: 'Duplicate recovery request must never bypass dual control' });
    expect(duplicate.status).toBe(409);
  });

  it('denies approval by the initiating administrator or the target user', async () => {
    const self = await a.post(`/api/v1/auth/mfa/recovery-requests/${requestId}/approve`, {});
    expect(self.status).toBe(403);
    const badRole = await target.post(`/api/v1/auth/mfa/recovery-requests/${requestId}/approve`, {});
    expect(badRole.status).toBe(403);
    const [row] = await sql`SELECT status FROM mfa_recovery_requests WHERE id = ${requestId}`;
    expect(row.status).toBe('PENDING');
  });

  it('requires fresh MFA by the second administrator, resets MFA and revokes old sessions', async () => {
    const actor = await b.get('/api/v1/auth/me');
    expect(actor.body.role).toBe('super_admin');
    const approved = await b.post(`/api/v1/auth/mfa/recovery-requests/${requestId}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect((await target.get('/api/v1/auth/me')).status).toBe(401);
    const [row] = await sql`SELECT mfa_enabled, mfa_secret_enc,
      token_version, force_password_change FROM users WHERE id = ${targetId}`;
    expect(row.mfaEnabled).toBe(false);
    expect(row.mfaSecretEnc).toBeNull();
    expect(row.forcePasswordChange).toBe(true);
    const events = await sql`SELECT action FROM audit_events WHERE entity_id = ${requestId}
      AND action LIKE 'auth.mfa_recovery_%' ORDER BY at`;
    expect(events.map((x) => x.action)).toEqual([
      'auth.mfa_recovery_requested', 'auth.mfa_recovery_approved',
    ]);
    expect((await b.post(`/api/v1/auth/mfa/recovery-requests/${requestId}/approve`, {})).status).toBe(409);
  });

  it('forces recovered account through password rotation and MFA re-enrollment', async () => {
    const attempt = await app.inject({ method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'salesmanager@defendit360.com', password: NEW_PW } });
    expect(attempt.statusCode).toBe(200);
    expect(attempt.json().user.forcePasswordChange).toBe(true);
    expect(attempt.json().mfaEnrolled).toBe(false);
    expect((await api(app, attempt.json().token).get('/api/v1/customers')).status).toBe(403);
    expect((await api(app, attempt.json().token).post('/api/v1/auth/mfa/setup', {})).status).toBe(403);
  });
});

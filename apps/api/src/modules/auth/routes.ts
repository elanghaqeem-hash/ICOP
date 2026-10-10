import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/context.js';
import { PERMISSIONS, can } from '../../lib/rbac.js';
import { config } from '../../config.js';
import { encryptSecret, decryptSecret } from '../../lib/secrets.js';
import { mfaChallengeRequired } from './policy.js';
import { matchTotp, newTotpSecret, provisioningUri } from './totp.js';

const LoginBody = z.object({ tenant: z.string().min(1).default('DEIT'), email: z.string().email(), password: z.string().min(1) });
const PasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).regex(/[A-Z]/, 'huruf besar').regex(/[a-z]/, 'huruf kecil').regex(/[0-9]/, 'angka').regex(/[^A-Za-z0-9]/, 'simbol'),
});

const CodeBody = z.object({ code: z.string().regex(/^\d{6}$/, 'Kode autentikator wajib 6 digit') });
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export async function authRoutes(app: FastifyInstance) {
  const userView = (u: Record<string, unknown>) => ({
    id: u.id, email: u.email, fullName: u.fullName, role: u.role,
    customerId: u.customerId, forcePasswordChange: u.forcePasswordChange,
  });
  function issueToken(u: Record<string, unknown>, verifiedMfa = false) {
    const needed = mfaChallengeRequired(String(u.role), !!u.mfaEnabled);
    const purpose = u.forcePasswordChange ? 'password_change' :
      needed && !verifiedMfa ? 'mfa' : undefined;
    const token = app.jwt.sign({
      sub: String(u.id), tid: String(u.tenantId), role: String(u.role),
      tv: Number(u.tokenVersion), pwc: !!u.forcePasswordChange,
      mfa: verifiedMfa, purpose,
    }, { expiresIn: purpose === 'mfa' ? '5m' : config.jwtTtl });
    return { token, mfaRequired: needed && !verifiedMfa,
      mfaEnrolled: !!u.mfaEnabled, user: userView(u) };
  }
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: Number(process.env.LOGIN_RATE_LIMIT ?? 10), timeWindow: '1 minute' } } }, async (req) => {
    const body = LoginBody.parse(req.body);
    const sql = app.sql;
    const [u] = await sql`
      SELECT u.* FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE t.code = ${body.tenant} AND lower(u.email) = lower(${body.email})`;
    const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'Email atau password salah');
    if (!u || !u.isActive) {
      await bcrypt.compare(body.password, '$2a$12$abcdefghijklmnopqrstuuJ0Cq7m1E2oQ1pjvZ6uX5S0b0Vb1uSPu'); // timing equalisation
      throw invalid;
    }
    if (u.lockedUntil && new Date(u.lockedUntil as string) > new Date()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', 'Akun terkunci sementara karena percobaan login gagal berulang');
    }
    const ok = await bcrypt.compare(body.password, u.passwordHash as string);
    if (!ok) {
      const failed = (u.failedLogins as number) + 1;
      await sql`UPDATE users SET failed_logins = ${failed},
        locked_until = CASE WHEN ${failed} >= ${MAX_FAILED} THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE NULL END
        WHERE id = ${u.id}`;
      await audit(sql, { tenantId: u.tenantId as string, id: u.id as string }, 'auth.login_failed', 'user', u.id as string, null, { failed }, req.ip);
      throw invalid;
    }
    await sql`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ${u.id}`;
    await audit(sql, { tenantId: u.tenantId as string, id: u.id as string }, 'auth.login', 'user', u.id as string, null, null, req.ip);
    return issueToken(u);

  });

  app.get('/api/v1/auth/me', { onRequest: [app.authenticate] }, async (req) => {
    const u = req.authUser;
    const perms = Object.keys(PERMISSIONS).filter((p) => can(u.role, p));
    const enrolled = !!u.mfaEnrolled;
    const needed = mfaChallengeRequired(u.role, enrolled);
    const limited = u.mfaVerified !== true && needed;
    return { ...u, permissions: limited ? [] : perms,
      mfaRequired: limited, mfaEnrolled: enrolled, mfaVerified: u.mfaVerified === true };
  });

  app.post('/api/v1/auth/change-password', { onRequest: [app.authenticate] }, async (req) => {
    const body = PasswordBody.parse(req.body);
    const sql = app.sql;
    const [u] = await sql`SELECT * FROM users WHERE id = ${req.authUser.id}`;
    if (!(await bcrypt.compare(body.currentPassword, u.passwordHash as string))) {
      throw new AppError(400, 'INVALID_PASSWORD', 'Password saat ini salah');
    }
    if (body.currentPassword === body.newPassword) throw new AppError(400, 'PASSWORD_REUSE', 'Password baru harus berbeda');
    const hash = await bcrypt.hash(body.newPassword, 12);
    // token_version++ mencabut semua sesi lama
    const [upd] = await sql`UPDATE users SET password_hash = ${hash}, force_password_change = false, token_version = token_version + 1, updated_at = now()
                            WHERE id = ${u.id} RETURNING *`;
    await audit(sql, req.authUser, 'auth.password_changed', 'user', u.id as string, null, null, req.ip);
    return issueToken(upd);
  });


  // Setup requires a password-verified session. Pre-MFA challenge JWTs are
  // short lived and are blocked from all commercial API routes.
  app.post('/api/v1/auth/mfa/setup', { onRequest: [app.authenticate],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const u = req.authUser;
    const sql = app.sql;
    const [row] = await sql`SELECT * FROM users WHERE tenant_id = ${u.tenantId} AND id = ${u.id}`;
    if (row.forcePasswordChange) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Ganti password sebelum mendaftarkan MFA');
    if (row.mfaEnabled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'MFA sudah terdaftar');
    const secret = newTotpSecret();
    await sql`UPDATE users SET mfa_pending_secret_enc = ${encryptSecret(secret)},
        mfa_pending_expires_at = now() + interval '10 minutes'
        WHERE tenant_id = ${u.tenantId} AND id = ${u.id}`;
    await audit(sql, u, 'auth.mfa_setup_started', 'user', u.id, null, null, req.ip);
    return { secret, otpauthUri: provisioningUri(secret, String(row.email)), expiresInSeconds: 600 };
  });

  app.post('/api/v1/auth/mfa/enable', { onRequest: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = CodeBody.parse(req.body);
    const u = req.authUser;
    const out = await app.sql.begin(async (tx) => {
      const [row] = await tx`SELECT * FROM users WHERE tenant_id = ${u.tenantId} AND id = ${u.id} FOR UPDATE`;
      if (!row || row.forcePasswordChange) return { error: 'PASSWORD_CHANGE_REQUIRED' };
      if (row.mfaEnabled) return { error: 'MFA_ALREADY_ENABLED' };
      if (row.mfaLockedUntil && new Date(row.mfaLockedUntil as string) > new Date()) return { error: 'MFA_LOCKED' };
      if (!row.mfaPendingSecretEnc || !row.mfaPendingExpiresAt || new Date(row.mfaPendingExpiresAt as string) < new Date()) return { error: 'MFA_SETUP_EXPIRED' };
      const step = matchTotp(decryptSecret(row.mfaPendingSecretEnc as string), code);
      if (step === null) {
        const failures = Number(row.mfaFailedAttempts) + 1;
        await tx`UPDATE users SET mfa_failed_attempts = ${failures},
          mfa_locked_until = CASE WHEN ${failures} >= 5 THEN now() + interval '15 minutes' ELSE NULL END
          WHERE tenant_id = ${u.tenantId} AND id = ${u.id}`;
        return { error: failures >= 5 ? 'MFA_LOCKED' : 'INVALID_MFA_CODE' };
      }
      const [updated] = await tx`UPDATE users SET mfa_enabled = true,
        mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = NULL,
        mfa_pending_expires_at = NULL, mfa_last_step = ${step},
        mfa_failed_attempts = 0, mfa_locked_until = NULL, token_version = token_version + 1
        WHERE tenant_id = ${u.tenantId} AND id = ${u.id} RETURNING *`;
      await audit(tx, u, 'auth.mfa_enabled', 'user', u.id, null, { method: 'totp' }, req.ip);
      return { updated };
    });
    if ('error' in out) throw new AppError(out.error === 'MFA_LOCKED' ? 423 : 403,
      out.error!, 'Pendaftaran MFA belum dapat diselesaikan');
    return issueToken(out.updated!, true);
  });

  app.post('/api/v1/auth/mfa/verify', { onRequest: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = CodeBody.parse(req.body);
    const u = req.authUser;
    const out = await app.sql.begin(async (tx) => {
      const [row] = await tx`SELECT * FROM users WHERE tenant_id = ${u.tenantId} AND id = ${u.id} FOR UPDATE`;
      if (!row || row.forcePasswordChange) return { error: 'PASSWORD_CHANGE_REQUIRED' };
      if (!row.mfaEnabled || !row.mfaSecretEnc) return { error: 'MFA_SETUP_REQUIRED' };
      if (row.mfaLockedUntil && new Date(row.mfaLockedUntil as string) > new Date()) return { error: 'MFA_LOCKED' };
      const step = matchTotp(decryptSecret(row.mfaSecretEnc as string), code, Number(row.mfaLastStep));
      if (step === null) {
        const failures = Number(row.mfaFailedAttempts) + 1;
        await tx`UPDATE users SET mfa_failed_attempts = ${failures},
          mfa_locked_until = CASE WHEN ${failures} >= 5 THEN now() + interval '15 minutes' ELSE NULL END
          WHERE tenant_id = ${u.tenantId} AND id = ${u.id}`;
        return { error: failures >= 5 ? 'MFA_LOCKED' : 'INVALID_MFA_CODE' };
      }
      const [updated] = await tx`UPDATE users SET mfa_last_step = ${step},
        mfa_failed_attempts = 0, mfa_locked_until = NULL
        WHERE tenant_id = ${u.tenantId} AND id = ${u.id} RETURNING *`;
      await audit(tx, u, 'auth.mfa_verified', 'user', u.id, null, { method: 'totp' }, req.ip);
      return { updated };
    });
    if ('error' in out) throw new AppError(out.error === 'MFA_LOCKED' ? 423 : 403,
      out.error!, 'Verifikasi autentikator gagal');
    return issueToken(out.updated!, true);
  });
  app.post('/api/v1/auth/logout-all', { onRequest: [app.authenticate] }, async (req) => {
    await app.sql`UPDATE users SET token_version = token_version + 1 WHERE id = ${req.authUser.id}`;
    await audit(app.sql, req.authUser, 'auth.logout_all', 'user', req.authUser.id, null, null, req.ip);
    return { ok: true };
  });
}

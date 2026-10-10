import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/context.js';
import { PERMISSIONS, can } from '../../lib/rbac.js';

const LoginBody = z.object({ tenant: z.string().min(1).default('DEIT'), email: z.string().email(), password: z.string().min(1) });
const PasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).regex(/[A-Z]/, 'huruf besar').regex(/[a-z]/, 'huruf kecil').regex(/[0-9]/, 'angka').regex(/[^A-Za-z0-9]/, 'simbol'),
});

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export async function authRoutes(app: FastifyInstance) {
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
    const token = app.jwt.sign({ sub: u.id as string, tid: u.tenantId as string, role: u.role as string, tv: u.tokenVersion as number, pwc: u.forcePasswordChange as boolean });
    return {
      token,
      user: { id: u.id, email: u.email, fullName: u.fullName, role: u.role, customerId: u.customerId, forcePasswordChange: u.forcePasswordChange },
    };
  });

  app.get('/api/v1/auth/me', { onRequest: [app.authenticate] }, async (req) => {
    const u = req.authUser;
    const perms = Object.keys(PERMISSIONS).filter((p) => can(u.role, p));
    return { ...u, permissions: perms };
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
                            WHERE id = ${u.id} RETURNING token_version, role, tenant_id`;
    await audit(sql, req.authUser, 'auth.password_changed', 'user', u.id as string, null, null, req.ip);
    const token = app.jwt.sign({ sub: u.id as string, tid: upd.tenantId as string, role: upd.role as string, tv: upd.tokenVersion as number, pwc: false });
    return { token };
  });

  app.post('/api/v1/auth/logout-all', { onRequest: [app.authenticate] }, async (req) => {
    await app.sql`UPDATE users SET token_version = token_version + 1 WHERE id = ${req.authUser.id}`;
    await audit(app.sql, req.authUser, 'auth.logout_all', 'user', req.authUser.id, null, null, req.ip);
    return { ok: true };
  });
}

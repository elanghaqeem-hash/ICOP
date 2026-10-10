import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requirePerm, type AuthUser } from '../../lib/context.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { APPROVAL_STEP_UP_SECONDS } from '../../lib/approval-mfa.js';

const Create = z.object({
  targetUserId: z.string().uuid(),
  reason: z.string().trim().min(20).max(2000),
});
const Params = z.object({ id: z.string().uuid() });

function requireRecoveryApprover(u: AuthUser) {
  if (!['company_admin', 'super_admin'].includes(u.role)) throw forbidden('Hanya administrator terotorisasi');
  const now = Math.floor(Date.now() / 1000);
  if (!u.mfaEnrolled || !u.mfaVerified || !Number.isFinite(u.mfaAt) ||
      !u.mfaAt || u.mfaAt > now || now - u.mfaAt >= APPROVAL_STEP_UP_SECONDS) {
    throw new AppError(403, 'MFA_STEP_UP_REQUIRED', 'Administrator wajib melakukan MFA ulang sebelum pemulihan akun');
  }
}

export async function mfaRecoveryRoutes(app: FastifyInstance) {
  const sql = app.sql;
  const admin = { onRequest: [app.authenticate], preValidation: requirePerm('user.manage') };
  const guarded = { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/api/v1/auth/mfa/recovery-targets', admin, async (req) => {
    requireRecoveryApprover(req.authUser);
    const items = await sql`SELECT id, email, full_name, role, mfa_enabled
      FROM users WHERE tenant_id = ${req.authUser.tenantId} AND id <> ${req.authUser.id}
        AND is_active AND mfa_enabled ORDER BY full_name LIMIT 250`;
    return { items };
  });

  app.get('/api/v1/auth/mfa/recovery-requests', admin, async (req) => {
    requireRecoveryApprover(req.authUser);
    const items = await sql`SELECT r.id, r.status, r.reason, r.created_at, r.expires_at, r.decided_at,
          r.requested_by, r.approved_by, r.target_user_id, u.email AS target_email,
          u.full_name AS target_name
      FROM mfa_recovery_requests r JOIN users u ON u.id = r.target_user_id
      WHERE r.tenant_id = ${req.authUser.tenantId}
      ORDER BY r.created_at DESC LIMIT 100`;
    return { items };
  });

  app.post('/api/v1/auth/mfa/recovery-requests', guarded, async (req, reply) => {
    const u = req.authUser;
    requireRecoveryApprover(u);
    const b = Create.parse(req.body);
    if (b.targetUserId === u.id) throw forbidden('Tidak boleh memulihkan MFA sendiri');
    const [target] = await sql`SELECT id, mfa_enabled FROM users
      WHERE tenant_id = ${u.tenantId} AND id = ${b.targetUserId} AND is_active`;
    if (!target) throw notFound('Akun sasaran dalam tenant');
    if (!target.mfaEnabled) throw new AppError(409, 'MFA_NOT_ENABLED', 'Akun tidak memiliki MFA aktif');
    const [request] = await sql.begin(async (tx) => {
      // Expired requests must not permanently block new requests for the user.
      await tx`UPDATE mfa_recovery_requests SET status = 'EXPIRED', decided_at = now()
        WHERE tenant_id = ${u.tenantId} AND target_user_id = ${b.targetUserId}
          AND status = 'PENDING' AND expires_at <= now()`;
      const [created] = await tx`INSERT INTO mfa_recovery_requests
        (tenant_id, target_user_id, requested_by, reason)
        VALUES (${u.tenantId}, ${b.targetUserId}, ${u.id}, ${b.reason}) RETURNING id, status, expires_at`;
      await audit(tx, u, 'auth.mfa_recovery_requested', 'mfa_recovery', String(created.id),
        null, { targetUserId: b.targetUserId }, req.ip);
      return [created];
    });
    reply.code(201);
    return request;
  });

  app.post('/api/v1/auth/mfa/recovery-requests/:id/approve', guarded, async (req) => {
    const u = req.authUser;
    requireRecoveryApprover(u);
    const { id } = Params.parse(req.params);
    const approved = await sql.begin(async (tx) => {
      const [recovery] = await tx`SELECT * FROM mfa_recovery_requests
        WHERE tenant_id = ${u.tenantId} AND id = ${id} FOR UPDATE`;
      if (!recovery) throw notFound('Permintaan pemulihan MFA');
      if (recovery.status !== 'PENDING') throw new AppError(409, 'MFA_RECOVERY_CLOSED', 'Permintaan telah diputuskan');
      if (new Date(recovery.expiresAt as string).getTime() <= Date.now()) {
        await tx`UPDATE mfa_recovery_requests SET status = 'EXPIRED', decided_at = now() WHERE id = ${id}`;
        // Do not depend on commit of a failing transaction: return a safe result.
        return { expired: true };
      }
      if (recovery.requestedBy === u.id || recovery.targetUserId === u.id) {
        throw forbidden('Keputusan wajib dilakukan administrator kedua, bukan pemohon/akun sasaran');
      }
      const [target] = await tx`SELECT id, mfa_enabled FROM users
        WHERE tenant_id = ${u.tenantId} AND id = ${recovery.targetUserId} AND is_active FOR UPDATE`;
      if (!target || !target.mfaEnabled) throw new AppError(409, 'MFA_TARGET_CHANGED', 'MFA akun sasaran telah berubah');
      await tx`UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL,
          mfa_pending_secret_enc = NULL, mfa_pending_expires_at = NULL,
          mfa_last_step = -1, mfa_failed_attempts = 0, mfa_locked_until = NULL,
          token_version = token_version + 1, force_password_change = true, updated_at = now()
        WHERE tenant_id = ${u.tenantId} AND id = ${recovery.targetUserId}`;
      await tx`UPDATE mfa_recovery_requests SET status = 'APPROVED',
        approved_by = ${u.id}, decided_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'auth.mfa_recovery_approved', 'mfa_recovery', id,
        { status: 'PENDING' }, { status: 'APPROVED', targetUserId: recovery.targetUserId }, req.ip);
      return { ok: true, status: 'APPROVED', targetUserId: recovery.targetUserId };
    });
    if ('expired' in approved) throw new AppError(410, 'MFA_RECOVERY_EXPIRED', 'Permintaan telah kedaluwarsa');
    return approved;
  });

  app.post('/api/v1/auth/mfa/recovery-requests/:id/reject', guarded, async (req) => {
    const u = req.authUser;
    requireRecoveryApprover(u);
    const { id } = Params.parse(req.params);
    return sql.begin(async (tx) => {
      const [recovery] = await tx`SELECT * FROM mfa_recovery_requests
        WHERE tenant_id = ${u.tenantId} AND id = ${id} FOR UPDATE`;
      if (!recovery) throw notFound('Permintaan pemulihan MFA');
      if (recovery.status !== 'PENDING') throw new AppError(409, 'MFA_RECOVERY_CLOSED', 'Permintaan telah diputuskan');
      if (recovery.requestedBy === u.id) throw forbidden('Pemohon tidak boleh memutuskan sendiri');
      await tx`UPDATE mfa_recovery_requests SET status = 'REJECTED', approved_by = ${u.id},
        decided_at = now() WHERE id = ${id}`;
      await audit(tx, u, 'auth.mfa_recovery_rejected', 'mfa_recovery', id,
        { status: 'PENDING' }, { status: 'REJECTED' }, req.ip);
      return { ok: true, status: 'REJECTED' };
    });
  });
}

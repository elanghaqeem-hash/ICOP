import type { FastifyReply, FastifyRequest } from 'fastify';
import { can } from './rbac.js';
import { AppError, forbidden } from './errors.js';
import type { Sql, Tx } from '../db.js';

export interface AuthUser {
  id: string;
  tenantId: string;
  role: string;
  email: string;
  fullName: string;
  customerId: string | null;
  tv: number;
  mfaEnrolled?: boolean;
  mfaVerified?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser;
  }
  interface FastifyInstance {
    sql: Sql;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; tid: string; role: string; tv: number; pwc?: boolean; mfa?: boolean; purpose?: string };
  }
}

export function requirePerm(perm: string) {
  return async (req: FastifyRequest) => {
    if (!req.authUser) throw new AppError(401, 'UNAUTHENTICATED', 'Login diperlukan');
    if (!can(req.authUser.role, perm)) throw forbidden(`Role ${req.authUser.role} tidak memiliki izin ${perm}`);
  };
}

export async function audit(
  db: Sql | Tx,
  u: { tenantId: string; id?: string | null },
  action: string,
  entityType: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
  ip?: string,
) {
  await db`
    INSERT INTO audit_events (tenant_id, actor_id, action, entity_type, entity_id, before, after, ip)
    VALUES (${u.tenantId}, ${u.id ?? null}, ${action}, ${entityType}, ${entityId},
            ${before === undefined || before === null ? null : db.json(before as never)},
            ${after === undefined || after === null ? null : db.json(after as never)}, ${ip ?? null})`;
}

export async function nextNumber(tx: Tx, tenantId: string, seqName: string, period: string): Promise<number> {
  const [row] = await tx`
    INSERT INTO number_sequences (tenant_id, seq_name, period, last_value)
    VALUES (${tenantId}, ${seqName}, ${period}, 1)
    ON CONFLICT (tenant_id, seq_name, period) DO UPDATE SET last_value = number_sequences.last_value + 1
    RETURNING last_value`;
  return Number(row.lastValue);
}

export async function notify(db: Sql | Tx, tenantId: string, userIds: string[], kind: string, title: string, body: string, link: string) {
  for (const uid of userIds) {
    await db`INSERT INTO notifications (tenant_id, user_id, kind, title, body, link) VALUES (${tenantId}, ${uid}, ${kind}, ${title}, ${body}, ${link})`;
  }
}

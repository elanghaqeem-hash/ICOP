import type { FastifyReply, FastifyRequest } from 'fastify';
import { conflict } from './errors.js';

/**
 * Idempotent execution for state-changing endpoints. When the client sends
 * `Idempotency-Key`, a replay of the same key returns the first response instead
 * of executing the side effect again (acceptance test #17).
 */
export async function idempotent<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = req.headers['idempotency-key'];
  if (!key || typeof key !== 'string') {
    reply.code(statusCode);
    return fn();
  }
  const sql = req.server.sql;
  const u = req.authUser;
  const route = `${req.method} ${req.routeOptions.url}`;
  const inserted = await sql`
    INSERT INTO idempotency_keys (tenant_id, key, user_id, route)
    VALUES (${u.tenantId}, ${key}, ${u.id}, ${route})
    ON CONFLICT DO NOTHING RETURNING key`;
  if (inserted.length === 0) {
    const [prev] = await sql`SELECT * FROM idempotency_keys WHERE tenant_id = ${u.tenantId} AND key = ${key}`;
    if (prev.route !== route || prev.userId !== u.id) throw conflict('Idempotency-Key sudah dipakai untuk request lain');
    if (prev.statusCode == null) throw conflict('Request dengan Idempotency-Key ini masih diproses');
    reply.header('idempotent-replay', 'true');
    reply.code(prev.statusCode as number);
    return prev.response as T;
  }
  try {
    const result = await fn();
    await sql`UPDATE idempotency_keys SET status_code = ${statusCode}, response = ${sql.json(result as never)}
              WHERE tenant_id = ${u.tenantId} AND key = ${key}`;
    reply.code(statusCode);
    return result;
  } catch (e) {
    await sql`DELETE FROM idempotency_keys WHERE tenant_id = ${u.tenantId} AND key = ${key}`;
    throw e;
  }
}

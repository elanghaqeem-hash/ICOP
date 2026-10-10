import type { FastifyInstance } from 'fastify';
import { createSql, type Sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import type { FetchLike } from '../src/modules/ai/providers.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://icop_app:icop_dev_password_2026@localhost:5432/icop_test';
export const SEED_PW = 'Seed!Passw0rd-Test';
export const NEW_PW = 'N3w!Strong-Passw0rd';

export async function freshDb(): Promise<Sql> {
  const sql = createSql(TEST_DB);
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await migrate(sql, () => {});
  await seed(sql, { password: SEED_PW });
  return sql;
}

export async function makeApp(sql: Sql, aiFetch?: FetchLike) {
  return buildApp({ sql, logger: false, aiFetch });
}

/** Login, lalu ganti password wajib (first-login) — kembalikan token final. */
export async function login(app: FastifyInstance, email: string): Promise<string> {
  let res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: NEW_PW } });
  if (res.statusCode === 200) return res.json().token;
  res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: SEED_PW } });
  if (res.statusCode !== 200) throw new Error(`login ${email}: ${res.body}`);
  const first = res.json().token as string;
  const ch = await app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: { authorization: `Bearer ${first}` },
    payload: { currentPassword: SEED_PW, newPassword: NEW_PW } });
  if (ch.statusCode !== 200) throw new Error(`change pw ${email}: ${ch.body}`);
  return ch.json().token;
}

export function api(app: FastifyInstance, token: string) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}`, ...headers } });
    let body: any;
    try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body, headers: res.headers };
  };
  return {
    get: (u: string) => call('GET', u),
    post: (u: string, p?: unknown, h?: Record<string, string>) => call('POST', u, p ?? {}, h),
    put: (u: string, p?: unknown) => call('PUT', u, p),
    patch: (u: string, p?: unknown) => call('PATCH', u, p),
    delete: (u: string) => call('DELETE', u),
  };
}

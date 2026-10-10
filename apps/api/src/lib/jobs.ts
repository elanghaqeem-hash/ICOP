import type { Sql } from '../db.js';

/**
 * Antrian job berbasis PostgreSQL (FOR UPDATE SKIP LOCKED) untuk pekerjaan berat:
 * OCR, kompresi, analisis AI dokumen. Aman untuk >1 instance API.
 */
export type JobHandler = (sql: Sql, job: { id: number; tenantId: string; payload: any; createdBy: string | null }, progress: (p: unknown) => Promise<void>) => Promise<void>;
const handlers = new Map<string, JobHandler>();
export const registerJob = (kind: string, fn: JobHandler) => handlers.set(kind, fn);

export async function enqueue(sql: Sql | any, tenantId: string, kind: string, payload: unknown, createdBy: string | null, maxAttempts = 2) {
  const [j] = await sql`INSERT INTO jobs (tenant_id, kind, payload, created_by, max_attempts) VALUES (${tenantId}, ${kind}, ${sql.json(payload as never)}, ${createdBy}, ${maxAttempts}) RETURNING id`;
  return Number(j.id);
}

/** Ambil & jalankan sampai `limit` job. Dipanggil worker loop dan tes. */
export async function runJobsOnce(sql: Sql, limit = 5) {
  let ran = 0;
  for (let i = 0; i < limit; i++) {
    const [job] = await sql`
      UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, started_at = now()
      WHERE id = (SELECT id FROM jobs WHERE status = 'QUEUED' AND run_after <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`;
    if (!job) break;
    ran++;
    const fn = handlers.get(job.kind as string);
    try {
      if (!fn) throw new Error(`Handler job ${job.kind} tidak terdaftar`);
      await fn(sql, { id: Number(job.id), tenantId: job.tenantId as string, payload: job.payload, createdBy: (job.createdBy as string) ?? null },
        async (p) => { await sql`UPDATE jobs SET progress = ${sql.json(p as never)} WHERE id = ${job.id}`; });
      await sql`UPDATE jobs SET status = 'DONE', finished_at = now(), last_error = NULL WHERE id = ${job.id}`;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 1000);
      const retry = (job.attempts as number) < (job.maxAttempts as number);
      await sql`UPDATE jobs SET status = ${retry ? 'QUEUED' : 'FAILED'}, last_error = ${msg}, run_after = now() + interval '30 seconds',
               finished_at = ${retry ? null : sql`now()`} WHERE id = ${job.id}`;
    }
  }
  return ran;
}

export function startWorker(sql: Sql, log: { error: (o: unknown, m?: string) => void }, intervalMs = 2000) {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { while ((await runJobsOnce(sql, 3)) > 0) { /* drain */ } } catch (e) { log.error(e, 'job worker'); } finally { busy = false; }
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}

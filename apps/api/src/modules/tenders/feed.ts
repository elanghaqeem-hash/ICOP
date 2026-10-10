import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { getIntegration } from '../../lib/integrations.js';
import { importTenders, TenderBody } from './routes.js';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let feedFetch: FetchFn = (u, i) => fetch(u, i);
export function setFeedFetch(f?: FetchFn) { feedFetch = f ?? ((u, i) => fetch(u, i)); }

interface FeedCfg { url: string; minRelevance: number; intervalHours: number }

/** Tarik feed tender JSON dari sumber sah lalu impor (dedup + skor relevansi). Item tidak valid dilewati & dihitung. */
export async function pullTenderFeed(sql: any, tenantId: string, actorId: string | null) {
  const it = await getIntegration<FeedCfg, { apiKey?: string }>(sql, tenantId, 'TENDER_FEED');
  if (!it || !it.enabled) throw new AppError(409, 'INTEGRATION_DISABLED', 'Feed tender belum dikonfigurasi/diaktifkan');
  const [owner] = actorId ? [{ id: actorId }] : await sql`SELECT updated_by AS id FROM integration_credentials WHERE tenant_id = ${tenantId} AND kind = 'TENDER_FEED'`;
  if (!owner?.id) throw new AppError(409, 'INTEGRATION_DISABLED', 'Feed tender tidak memiliki penanggung jawab');
  const res = await feedFetch(it.config.url, { headers: { accept: 'application/json', ...(it.secrets.apiKey ? { authorization: `Bearer ${it.secrets.apiKey}` } : {}) }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new AppError(502, 'FEED_FAILED', `Feed tender mengembalikan HTTP ${res.status}`);
  const body = await res.json().catch(() => { throw new AppError(502, 'FEED_FAILED', 'Feed tender bukan JSON'); });
  const raw: unknown[] = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
  const valid: z.infer<typeof TenderBody>[] = []; let invalid = 0;
  for (const r of raw.slice(0, 500)) { const p = TenderBody.safeParse(r); if (p.success) valid.push(p.data); else invalid++; }
  const out = valid.length ? await importTenders(sql, { tenantId, id: owner.id as string }, valid, it.config.minRelevance ?? 15) : { created: [], duplicates: [], skippedIrrelevant: [] };
  await sql`UPDATE integration_credentials SET last_run_at = now() WHERE tenant_id = ${tenantId} AND kind = 'TENDER_FEED'`;
  return { received: raw.length, invalid, ...out };
}

/** Scheduler: tarik feed untuk tenant yang intervalnya sudah lewat. */
export async function scheduledTenderFeeds(sql: any) {
  const due = await sql`SELECT tenant_id FROM integration_credentials WHERE kind = 'TENDER_FEED' AND enabled
    AND (last_run_at IS NULL OR last_run_at < now() - make_interval(hours => coalesce((config->>'intervalHours')::int, 6)))`;
  let pulled = 0; let created = 0;
  for (const d of due) { try { const r = await pullTenderFeed(sql, d.tenantId as string, null); pulled++; created += r.created.length; } catch { /* dicatat pada tick berikutnya */ } }
  return { feedsPulled: pulled, tendersCreated: created };
}

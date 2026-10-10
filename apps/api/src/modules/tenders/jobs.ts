import type { Sql } from '../../db.js';
import { notify } from '../../lib/context.js';

/** Pengingat deadline submission H-3 / H-1 untuk tender aktif — maksimal sekali per tender per hari. */
export async function tenderDeadlineReminders(sql: Sql) {
  const rows = await sql`
    SELECT t.id, t.tenant_id, t.code, t.title, t.owner_id, t.submission_deadline, extract(epoch FROM t.submission_deadline - now())/3600 AS hours_left
    FROM tenders t
    WHERE t.status IN ('REGISTERED','BID_DECISION','PREPARING','INTERNAL_REVIEW','APPROVED') AND t.submission_deadline BETWEEN now() AND now() + interval '72 hours'
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.kind = 'TENDER_DEADLINE' AND n.link = '/tenders/' || t.id::text
                      AND (n.created_at AT TIME ZONE 'Asia/Jakarta')::date = (now() AT TIME ZONE 'Asia/Jakarta')::date)`;
  let sent = 0;
  for (const t of rows) {
    const users = await sql`SELECT id FROM users WHERE tenant_id = ${t.tenantId} AND is_active AND (id = ${t.ownerId} OR role = 'tender_officer')`;
    await notify(sql, t.tenantId as string, users.map((u) => u.id as string), 'TENDER_DEADLINE', `${t.code}: deadline ${Math.round(Number(t.hoursLeft))} jam lagi`, t.title as string, `/tenders/${t.id}`);
    sent++;
  }
  return { reminded: sent };
}

import { nextNumber, notify } from '../../lib/context.js';
import { loadSmtp, sendMail } from '../../lib/mailer.js';

const THRESHOLDS = [30, 60, 90, 180] as const;
const idr = (n: number) => `Rp ${Number(n).toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;

/**
 * Pengingat renewal kontrak aktif pada H-180/90/60/30 (sekali per ambang; bila kontrak dibuat sudah dekat akhir, hanya ambang terdekat).
 * Pada pengingat pertama dibuat opportunity renewal (stage LEAD) agar masuk pipeline.
 */
export async function renewalReminders(sql: any) {
  const due = await sql`SELECT c.*, (c.end_date - (now() AT TIME ZONE 'Asia/Jakarta')::date) AS days_left, o.service_category, o.owner_id
    FROM contracts c LEFT JOIN opportunities o ON o.id = c.opportunity_id
    WHERE c.status = 'ACTIVE' AND c.end_date - (now() AT TIME ZONE 'Asia/Jakarta')::date BETWEEN 0 AND 180`;
  let reminders = 0; let opportunities = 0;
  for (const c of due) {
    const daysLeft = Number(c.daysLeft);
    const threshold = THRESHOLDS.find((t) => daysLeft <= t)!;
    const [ins] = await sql`INSERT INTO renewal_reminders (tenant_id, contract_id, days_before) VALUES (${c.tenantId}, ${c.id}, ${threshold}) ON CONFLICT DO NOTHING RETURNING days_before`;
    if (!ins) continue;
    reminders++;
    await sql.begin(async (tx: any) => {
      let oppId = c.renewalOpportunityId as string | null;
      if (!oppId) {
        const year = new Date().getFullYear();
        const n = await nextNumber(tx, c.tenantId, 'OPPORTUNITY', String(year));
        const [o] = await tx`INSERT INTO opportunities (tenant_id, code, customer_id, name, service_category, amount_estimate, probability, expected_close, source, owner_id, competitors, next_action, created_by)
          VALUES (${c.tenantId}, ${`OPP-${year}-${String(n).padStart(4, '0')}`}, ${c.customerId}, ${`Renewal — ${c.title}`}, ${c.serviceCategory ?? 'OTHER'}, ${c.value}, 50, ${c.endDate},
                  'direct', ${c.ownerId ?? c.createdBy}, '{}', ${`Siapkan penawaran renewal sebelum ${String(c.endDate).slice(0, 10)}`}, ${c.createdBy}) RETURNING id, code`;
        oppId = o.id as string;
        await tx`UPDATE contracts SET renewal_opportunity_id = ${oppId} WHERE id = ${c.id}`;
        opportunities++;
      }
      const people = await tx`SELECT id FROM users WHERE tenant_id = ${c.tenantId} AND is_active AND (role IN ('account_manager','sales_manager') OR id = ${c.createdBy})`;
      await notify(tx, c.tenantId, people.map((x: any) => x.id as string), 'CONTRACT_RENEWAL', `Renewal H-${threshold}: ${c.number}`,
        `${c.title} berakhir ${String(c.endDate).slice(0, 10)} (${daysLeft} hari lagi)`, `/opportunities/${oppId}`);
    });
  }
  return { renewalReminders: reminders, renewalOpportunities: opportunities };
}

/**
 * Dunning invoice jatuh tempo: level 1 (≥1 hari), 2 (≥14 hari), 3 (≥30 hari; eskalasi ke manajemen). Sekali per level.
 * Email ke kontak finance/primary customer bila SMTP aktif; selalu notifikasi internal ke Finance.
 */
export async function dunningRun(sql: any) {
  const overdue = await sql`SELECT i.*, ((now() AT TIME ZONE 'Asia/Jakarta')::date - i.due_date) AS days_overdue, cu.legal_name AS customer_name
    FROM invoices i JOIN customers cu ON cu.id = i.customer_id
    WHERE i.status IN ('ISSUED','PARTIAL') AND i.due_date < (now() AT TIME ZONE 'Asia/Jakarta')::date`;
  let sent = 0; let emailed = 0;
  for (const inv of overdue) {
    const d = Number(inv.daysOverdue);
    const level = d >= 30 ? 3 : d >= 14 ? 2 : 1;
    const [done] = await sql`SELECT 1 FROM dunning_log WHERE invoice_id = ${inv.id} AND level >= ${level}`;
    if (done) continue;
    const outstanding = Number(inv.total) - Number(inv.paidTotal);
    const contacts = await sql`SELECT email FROM contacts WHERE customer_id = ${inv.customerId} AND email IS NOT NULL AND contact_role IN ('finance','primary','procurement')
                               UNION SELECT email FROM users WHERE customer_id = ${inv.customerId} AND is_active AND role = 'customer_user'`;
    const emails = [...new Set(contacts.map((x: any) => String(x.email).toLowerCase()))].slice(0, 10) as string[];
    let channel = 'notification'; let detail = 'SMTP tidak aktif atau kontak email tidak ada';
    const smtp = await loadSmtp(sql, inv.tenantId);
    if (smtp?.enabled && emails.length) {
      try {
        const tone = level === 1 ? 'Kami informasikan' : level === 2 ? 'Kami mengingatkan kembali' : 'Ini adalah pemberitahuan terakhir sebelum eskalasi bahwa';
        await sendMail(sql, inv.tenantId, { to: emails, subject: `Pengingat pembayaran ${inv.number} — jatuh tempo ${String(inv.dueDate).slice(0, 10)}`,
          html: `<p>Yth. ${inv.customerName},</p><p>${tone} invoice <b>${inv.number}</b> sebesar ${idr(Number(inv.total))} telah melewati jatuh tempo ${String(inv.dueDate).slice(0, 10)} (${d} hari).
                 Sisa tagihan: <b>${idr(outstanding)}</b>.</p><p>Abaikan pesan ini apabila pembayaran sudah dilakukan, dan mohon kirimkan bukti transfer untuk rekonsiliasi.</p>
                 <p>Hormat kami,<br>Finance — PT Data Enkripsi Informasi Teknologi (DefendIT360)</p>` });
        channel = 'email'; detail = `${emails.length} penerima`; emailed++;
      } catch (e) { detail = `Email gagal: ${(e as Error).message.slice(0, 150)}`; }
    }
    await sql`INSERT INTO dunning_log (tenant_id, invoice_id, level, channel, detail) VALUES (${inv.tenantId}, ${inv.id}, ${level}, ${channel}, ${detail}) ON CONFLICT DO NOTHING`;
    const roles = level === 3 ? ['pricing_finance', 'sales_manager', 'director'] : ['pricing_finance', 'account_manager'];
    const people = await sql`SELECT id FROM users WHERE tenant_id = ${inv.tenantId} AND is_active AND role IN ${sql(roles)}`;
    await notify(sql, inv.tenantId, people.map((x: any) => x.id as string), 'INVOICE_OVERDUE', `Dunning L${level}: ${inv.number} (${d} hari)`, `${inv.customerName} — sisa ${idr(outstanding)}`, `/billing/${inv.id}`);
    sent++;
  }
  return { dunningSent: sent, dunningEmailed: emailed };
}

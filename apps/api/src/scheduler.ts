import { escalateOverdue } from './modules/approvals/engine.js';
import { pollEsignSignatures } from './modules/contracts/routes.js';
import { expireWallets } from './modules/flexguard/routes.js';
import { slaBreachCheck } from './modules/helpdesk/routes.js';
import { dunningRun, renewalReminders } from './modules/renewal/jobs.js';
import { scheduledTenderFeeds } from './modules/tenders/feed.js';
import { tenderDeadlineReminders } from './modules/tenders/jobs.js';

/** Semua job terjadwal (scheduler internal tiap SCHEDULER_INTERVAL_MIN, atau dipicu manual oleh admin). Tiap job berdiri sendiri. */
export async function runScheduledJobs(sql: any) {
  const jobs: [string, () => Promise<Record<string, unknown>>][] = [
    ['escalation', () => escalateOverdue(sql)], ['tenderDeadlines', () => tenderDeadlineReminders(sql)], ['wallets', () => expireWallets(sql, null, null)],
    ['esign', () => pollEsignSignatures(sql)], ['tenderFeeds', () => scheduledTenderFeeds(sql)], ['sla', () => slaBreachCheck(sql)],
    ['renewal', () => renewalReminders(sql)], ['dunning', () => dunningRun(sql)],
  ];
  const out: Record<string, unknown> = {};
  for (const [name, fn] of jobs) { try { out[name] = await fn(); } catch (e) { out[name] = { error: (e as Error).message.slice(0, 200) }; } }
  return out;
}

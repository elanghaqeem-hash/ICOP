import { buildApp } from './app.js';
import { config } from './config.js';
import { inspectMigrationGate } from './migration-preflight.js';

const app = await buildApp();
// Strict release gate: a production API must NEVER serve traffic on a database
// with unapproved/pending/missing SQL migrations. This is READ ONLY, not a migration.
if (config.nodeEnv === 'production') {
  const gate = await inspectMigrationGate(app.sql, 'post');
  if (!gate.ok) {
    app.log.error({ migrationIssues: gate.issues },
      'Refusing to start: database schema has not passed release preflight');
    await app.close();
    process.exit(1);
  }
}
try {
  await app.listen({ port: config.port, host: config.host });
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
// Scheduler internal: eskalasi SLA approval & pengingat deadline tender (matikan dengan SCHEDULER_ENABLED=false bila memakai cron eksternal)
if (process.env.SCHEDULER_ENABLED !== 'false') {
  const { runScheduledJobs } = await import('./scheduler.js');
  const tick = async () => {
    try {
      const r = await runScheduledJobs(app.sql);
      app.log.info({ jobs: r }, 'scheduler tick');
    }
    catch (e) { app.log.error(e, 'scheduler failed'); }
  };
  setInterval(tick, Number(process.env.SCHEDULER_INTERVAL_MIN ?? 15) * 60_000).unref();
}
// Worker job: OCR, kompresi, analisis dokumen (matikan dengan JOB_WORKER_ENABLED=false bila worker dipisah)
if (process.env.JOB_WORKER_ENABLED !== 'false') {
  const { startWorker } = await import('./lib/jobs.js');
  startWorker(app.sql, app.log);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.close().then(() => process.exit(0)));

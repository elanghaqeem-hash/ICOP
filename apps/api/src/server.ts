import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();
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

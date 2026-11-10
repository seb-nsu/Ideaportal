import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { config, features, productionProblems } from './config.js';
import { closePool, withSystem } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { ensureDemoTenant } from './db/seed.js';
import { runAllJobs } from './jobs/deadlines.js';
import { processAiJobs } from './ai/worker.js';
import { purgeTenant } from './routes/pilot.js';
import { hasSecretKey } from './lib/secretbox.js';
import { checkAlerts, recordRun } from './services/ops.js';
import { recordStatusCheck } from './services/status.js';
import { operatorTokenConfigured } from './services/operator.js';
import { processExports } from './services/tenantExport.js';
import { runWebhookDeliveries } from './services/webhooks.js';
import { runSiemForwarding } from './services/siem.js';
import { runBackground } from './lib/requestContext.js';
import { jobRuns } from './lib/prometheus.js';
import { DEMO_WORKSPACES } from './db/demo-content.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = config.webDist ?? path.resolve(here, '../../web/dist');

async function main() {
  // Safe defaults (enterprise security): production refuses to start with weak settings.
  const problems = productionProblems();
  if (problems.length) {
    for (const p of problems) console.error(`[config] ${p}`);
    throw new Error('Refusing to start in production with an unsafe configuration (see the lines above).');
  }
  if (process.env.MIGRATE_ON_START !== 'false') await migrate();
  const app = await buildApp({ logger: true, webDist });
  if (!config.alerts.email && !config.alerts.webhookUrl) app.log.warn('No ALERT_EMAIL or ALERT_WEBHOOK_URL set: health alerts are only visible at /api/health.');
  if (config.operatorToken && !operatorTokenConfigured()) app.log.warn('OPERATOR_TOKEN is set but the operator console is off: it needs at least 32 characters and OPERATOR_TOTP_SECRET.');
  if (process.env.COOKIE_SECURE === 'false' && config.publicUrl.startsWith('https://')) app.log.warn('COOKIE_SECURE=false is ignored: PUBLIC_URL is https, so session cookies are always Secure.');
  if (!config.metricsToken) app.log.info('METRICS_TOKEN is not set: /api/metrics is off and /api/health shows only the status.');
  if (!hasSecretKey()) app.log.warn('SECRET_KEY is not set: TOTP secrets are stored unencrypted and AI keys cannot be saved. Set it in production.');
  await app.listen({ port: config.port, host: config.host });

  // Public demo: the shared workspace is created on start and reset to the example data once a day.
  const refreshDemo = async () => {
    if (!features.demo) return;
    const old = await withSystem(async (c) =>
      (await c.query<{ id: string }>("SELECT id FROM tenants WHERE slug = ANY($1) AND created_via = 'demo' AND created_at < now() - interval '24 hours'", [Object.values(DEMO_WORKSPACES).map((w) => w.slug)])).rows,
    );
    for (const t of old) await purgeTenant(t.id);
    if (await ensureDemoTenant()) app.log.info('demo workspace (re)created');
  };
  // Every background run has its own run id: in its log lines and in the audit rows it writes.
  const background = <T>(loop: string, fn: () => Promise<T>, onDone?: (r: T, log: typeof app.log) => void) =>
    runBackground(loop, async (runId) => {
      const log = app.log.child({ loop, runId });
      log.debug('background run started');
      try {
        const r = await fn();
        jobRuns.inc({ loop, outcome: 'ok' });
        onDone?.(r, log);
      } catch (err) {
        jobRuns.inc({ loop, outcome: 'failed' });
        log.error({ err }, `${loop} run failed`);
      }
    });
  const runJobs = () =>
    background('jobs', () => refreshDemo().then(() => runAllJobs()), (r, log) => {
      if (r) log.info({ jobs: r }, 'background jobs finished');
    });
  const timer = setInterval(runJobs, config.jobIntervalMinutes * 60_000);
  void runJobs();

  // AI analyses run in their own short loop so a submission gets its short analysis quickly.
  let aiBusy = false;
  const aiTimer = setInterval(() => {
    if (aiBusy) return;
    aiBusy = true;
    void background('ai', () => recordRun('ai', () => processAiJobs(5)), (n, log) => {
      if (n) log.info({ processed: n }, 'ai jobs processed');
    }).finally(() => (aiBusy = false));
  }, config.aiWorkerSeconds * 1000);

  // Webhook deliveries (R3-17) run in a short loop so receivers hear about changes within seconds;
  // the job loop sends them as well (retries, run-once).
  let hooksBusy = false;
  const webhookTimer = setInterval(() => {
    if (hooksBusy) return;
    hooksBusy = true;
    // SIEM forwarding of the audit log shares the loop (same sender, same retry rhythm).
    void background('webhooks', async () => ({ webhooks: await runWebhookDeliveries(), siem: await runSiemForwarding() }), (r, log) => {
      if (r.webhooks || r.siem) log.info(r, 'deliveries sent');
    }).finally(() => (hooksBusy = false));
  }, config.webhookSeconds * 1000);

  // Tenant exports as ZIP (enterprise) run in their own short loop, so the admin gets the file soon.
  let exportsBusy = false;
  const exportTimer = setInterval(() => {
    if (exportsBusy) return;
    exportsBusy = true;
    processExports()
      .catch((err) => app.log.error(err, 'tenant exports failed'))
      .finally(() => (exportsBusy = false));
  }, config.exportWorkerSeconds * 1000);

  // Health thresholds and alerts (R1-05) run on their own timer, so a stuck job loop is noticed.
  const alertTimer = setInterval(() => {
    checkAlerts()
      .then((r) => r.raised.length && app.log.warn({ alerts: r.raised }, 'alerts raised'))
      .catch((err) => app.log.error(err, 'alert check failed'));
    // Availability history for the status page (R3-10).
    recordStatusCheck().catch((err) => app.log.error(err, 'status check failed'));
  }, config.alerts.checkMinutes * 60_000);
  void recordStatusCheck().catch((err) => app.log.error(err, 'status check failed'));

  const shutdown = async () => {
    clearInterval(timer);
    clearInterval(aiTimer);
    clearInterval(webhookTimer);
    clearInterval(exportTimer);
    clearInterval(alertTimer);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

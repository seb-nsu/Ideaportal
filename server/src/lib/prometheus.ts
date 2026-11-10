import { timingSafeEqual } from 'node:crypto';
import client from 'prom-client';
import { config } from '../config.js';

// Prometheus metrics (enterprise observability), GET /api/metrics with METRICS_TOKEN.
// Labels never carry tenant names, ids, people or idea content: routes are patterns
// ("/api/ideas/:id"), AI calls are counted by agent and outcome only.

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'ideenportal_' });

export const httpDuration = new client.Histogram({
  name: 'ideenportal_http_request_duration_seconds',
  help: 'Duration of HTTP requests by route pattern, method and status code.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const aiCalls = new client.Counter({
  name: 'ideenportal_ai_calls_total',
  help: 'AI actions written to the AI log, by agent, outcome and whether the model ran locally.',
  labelNames: ['agent', 'status', 'local'] as const,
  registers: [registry],
});

export const aiCost = new client.Counter({
  name: 'ideenportal_ai_cost_eur_total',
  help: 'Estimated AI cost in euro, by agent.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const jobRuns = new client.Counter({
  name: 'ideenportal_background_runs_total',
  help: 'Background runs by loop and outcome.',
  labelNames: ['loop', 'outcome'] as const,
  registers: [registry],
});

export const siemBatches = new client.Counter({
  name: 'ideenportal_siem_batches_total',
  help: 'Audit batches sent to SIEM targets, by outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/** Figures read from the database on each scrape (set by the health service). */
export interface ScrapeFigures {
  aiQueued: number;
  aiRunning: number;
  outboxPending: number;
  webhookPending: number;
  loopAge: Record<string, number | null>;
}

let scrapeSource: (() => Promise<ScrapeFigures>) | null = null;

/** The routes module registers the database source once (keeps this module free of the pool). */
export function setScrapeSource(fn: () => Promise<ScrapeFigures>): void {
  scrapeSource = fn;
}

const aiQueue = new client.Gauge({
  name: 'ideenportal_ai_queue_jobs',
  help: 'AI jobs by state (all workspaces).',
  labelNames: ['state'] as const,
  registers: [registry],
});
const outbox = new client.Gauge({ name: 'ideenportal_outbox_pending', help: 'Mails waiting for immediate delivery.', registers: [registry] });
const webhooks = new client.Gauge({ name: 'ideenportal_webhook_deliveries_pending', help: 'Webhook deliveries waiting to be sent.', registers: [registry] });
const loopAge = new client.Gauge({
  name: 'ideenportal_job_last_run_age_seconds',
  help: 'Seconds since the last finished run of a background loop (-1 = never).',
  labelNames: ['loop'] as const,
  registers: [registry],
});

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  if (scrapeSource) {
    const f = await scrapeSource();
    aiQueue.set({ state: 'queued' }, f.aiQueued);
    aiQueue.set({ state: 'running' }, f.aiRunning);
    outbox.set(f.outboxPending);
    webhooks.set(f.webhookPending);
    for (const [loop, age] of Object.entries(f.loopAge)) loopAge.set({ loop }, age ?? -1);
  }
  return { contentType: registry.contentType, body: await registry.metrics() };
}

/** Records one AI action (gateway log); never throws. */
export function recordAiCall(agent: string, status: string, local: boolean, costEur: number): void {
  try {
    aiCalls.inc({ agent, status, local: String(local) });
    if (costEur > 0) aiCost.inc({ agent }, costEur);
  } catch {
    // metrics must never break an AI call
  }
}

/** True when the request carries "Authorization: Bearer <METRICS_TOKEN>" (constant-time compare). */
export function hasMetricsToken(authorization: string | undefined): boolean {
  const token = config.metricsToken;
  if (!token || !authorization?.startsWith('Bearer ')) return false;
  const given = Buffer.from(authorization.slice(7).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

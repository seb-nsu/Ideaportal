// Runtime configuration, read from environment variables only (R1-01).
export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ideenportal:ideenportal@localhost:5432/ideenportal',
  // TLS to PostgreSQL (R3-08): off (default; "sslmode" in DATABASE_URL still applies), require
  // (encrypted, certificate checked against the system CAs or DATABASE_SSL_CA) or no-verify
  // (encrypted without certificate check, only for providers with self-signed certificates).
  databaseSsl: (['off', 'require', 'no-verify'].includes(process.env.DATABASE_SSL ?? '') ? process.env.DATABASE_SSL : 'off') as 'off' | 'require' | 'no-verify',
  databaseSslCa: process.env.DATABASE_SSL_CA,
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
  // Secure cookies: always when PUBLIC_URL is https (COOKIE_SECURE=false cannot switch it off
  // then); COOKIE_SECURE=true forces them behind a TLS proxy with an http PUBLIC_URL.
  cookieSecure: process.env.COOKIE_SECURE === 'true' || (process.env.PUBLIC_URL ?? '').startsWith('https://'),
  // Log level of the server (fatal, error, warn, info, debug, trace, silent).
  logLevel: (process.env.LOG_LEVEL ?? 'info').toLowerCase(),
  // Bearer token for GET /api/metrics (Prometheus) and the details of /api/health. Without it
  // the metrics endpoint answers 404 and /api/health shows only the status.
  metricsToken: process.env.METRICS_TOKEN,
  // Optional check of new passwords against known data breaches: "hibp" (k-anonymity) or off.
  passwordBreachCheck: process.env.PASSWORD_BREACH_CHECK === 'hibp' ? 'hibp' : 'off',
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  jobIntervalMinutes: Number(process.env.JOB_INTERVAL_MINUTES ?? 15),
  mailTransport: process.env.MAIL_TRANSPORT ?? (process.env.SMTP_URL ? 'smtp' : 'log'),
  smtpUrl: process.env.SMTP_URL,
  mailFrom: process.env.MAIL_FROM ?? 'Ideenportal <no-reply@localhost>',
  webDist: process.env.WEB_DIST,
  // Encrypts provider keys stored per tenant (AES-256-GCM). Required to save keys.
  secretKey: process.env.SECRET_KEY,
  // Only during a key rotation (R3-41): the old key, so tenant keys not yet re-wrapped stay readable.
  secretKeyPrevious: process.env.SECRET_KEY_PREVIOUS,
  // Operator console (R3-07): enabled only with both values; no defaults. `npm run operator -w server -- setup`.
  operatorToken: process.env.OPERATOR_TOKEN,
  operatorTotpSecret: process.env.OPERATOR_TOTP_SECRET,
  operatorName: process.env.OPERATOR_NAME ?? 'operator',
  operatorSessionHours: Number(process.env.OPERATOR_SESSION_HOURS ?? 4),
  // Individual operator accounts (enterprise): the env token above is only the bootstrap path
  // while no active owner account exists; OPERATOR_BREAK_GLASS=true keeps it open as emergency access.
  operatorBreakGlass: process.env.OPERATOR_BREAK_GLASS === 'true',
  // Tenant lifecycle (enterprise): grace period before a requested deletion is carried out,
  // how long a finished export can be downloaded, and the loop of the export worker.
  tenantDeleteGraceDays: Math.max(0, Number(process.env.TENANT_DELETE_GRACE_DAYS ?? 30)),
  exportRetentionDays: Math.max(1, Number(process.env.EXPORT_RETENTION_DAYS ?? 7)),
  exportWorkerSeconds: Math.max(1, Number(process.env.EXPORT_WORKER_SECONDS ?? 10)),
  // Deleting a workspace after company login needs a login that is at most this old.
  reauthSsoMinutes: Math.max(1, Number(process.env.REAUTH_SSO_MINUTES ?? 10)),
  // Status page (R3-10): days of availability history shown publicly.
  statusHistoryDays: Number(process.env.STATUS_HISTORY_DAYS ?? 90),
  // Platform keys for tenants that use the operator's AI or search account (keySource "platform").
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiCompatibleApiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  braveApiKey: process.env.BRAVE_API_KEY,
  // Own models on localhost or in the private network (Ollama, vLLM) need this; keep it off for SaaS.
  aiAllowPrivateUrls: process.env.AI_ALLOW_PRIVATE_URLS === 'true',
  aiWorkerSeconds: Number(process.env.AI_WORKER_SECONDS ?? 5),
  // Short loop for webhook deliveries (R3-17).
  webhookSeconds: Number(process.env.WEBHOOK_SECONDS ?? 15),
  aiTimeoutSeconds: Number(process.env.AI_TIMEOUT_SECONDS ?? 300),
  // Fairness (R2-49): AI jobs running at the same time on this instance and per workspace.
  aiConcurrency: Math.max(1, Number(process.env.AI_CONCURRENCY ?? 2)),
  aiTenantConcurrency: Math.max(1, Number(process.env.AI_TENANT_CONCURRENCY ?? 1)),
  // Source check (R2-46): page fetch of web hits; false switches it off for the whole instance.
  aiPageFetch: process.env.AI_PAGE_FETCH !== 'false',
  // Company login (R3-26): issuer URLs in the private network or without https (own Keycloak,
  // ADFS in the intranet, tests). Keep it off for SaaS.
  oidcAllowPrivateUrls: process.env.OIDC_ALLOW_PRIVATE_URLS === 'true',
  // Scales all rate limits (R1-44); 0 switches them off, e.g. for load tests.
  rateLimitFactor: Number(process.env.RATE_LIMIT_FACTOR ?? 1),
  // Number of reverse proxies in front of the app (Render, load balancer). The client address
  // for rate limits is taken from X-Forwarded-For only as far as these hops are trusted.
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 1),
  // Health thresholds and alert channels (R1-05).
  alerts: {
    email: process.env.ALERT_EMAIL,
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
    checkMinutes: Number(process.env.ALERT_CHECK_MINUTES ?? 5),
    repeatHours: Number(process.env.ALERT_REPEAT_HOURS ?? 6),
    jobMaxAgeMinutes: Number(process.env.ALERT_JOB_MAX_AGE_MINUTES ?? Math.max(45, 3 * Number(process.env.JOB_INTERVAL_MINUTES ?? 15))),
    aiQueueMax: Number(process.env.ALERT_AI_QUEUE_MAX ?? 50),
    aiOldestMinutes: Number(process.env.ALERT_AI_OLDEST_MINUTES ?? 30),
    outboxMax: Number(process.env.ALERT_OUTBOX_MAX ?? 200),
    outboxOldestMinutes: Number(process.env.ALERT_OUTBOX_OLDEST_MINUTES ?? 60),
  },
};

/**
 * Operator and hosting details for the legal texts and the list of sub-processors (R3-08, R3-11).
 * Empty values stay placeholders in square brackets in the generated documents.
 */
export const compliance = {
  operatorName: process.env.OPERATOR_NAME ?? '',
  operatorAddress: process.env.OPERATOR_ADDRESS ?? '',
  operatorEmail: process.env.OPERATOR_EMAIL ?? '',
  privacyContact: process.env.PRIVACY_CONTACT ?? '',
  hostingProvider: process.env.HOSTING_PROVIDER ?? '',
  hostingRegion: process.env.HOSTING_REGION ?? '',
  // eu = EU/EEA, other = outside (needs a transfer mechanism), local = own data centre.
  hostingLocation: (['eu', 'other', 'local'].includes(process.env.HOSTING_LOCATION ?? '') ? process.env.HOSTING_LOCATION : 'eu') as 'eu' | 'other' | 'local',
  mailProvider: process.env.MAIL_PROVIDER ?? '',
  mailLocation: (['eu', 'other', 'local'].includes(process.env.MAIL_LOCATION ?? '') ? process.env.MAIL_LOCATION : 'eu') as 'eu' | 'other' | 'local',
};

/** Self-service sign-up of new workspaces (SIGNUP_ENABLED=false to switch off). */
export const features = {
  signup: process.env.SIGNUP_ENABLED !== 'false',
  /** One-click demo login into the seeded "demo" workspace. */
  demo: process.env.DEMO_MODE === 'true',
};

/**
 * Safe defaults for production (NODE_ENV=production): the server refuses to start without a
 * SECRET_KEY of at least 32 characters. Returns the problems; empty means the start may go on.
 */
export function productionProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (!env.SECRET_KEY || env.SECRET_KEY.length < 32) {
    problems.push('SECRET_KEY must be set to at least 32 random characters in production (e.g. openssl rand -base64 48).');
  }
  if (env.METRICS_TOKEN && env.METRICS_TOKEN.length < 24) problems.push('METRICS_TOKEN needs at least 24 characters.');
  return problems;
}

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one database; run files one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    // `npm run test:coverage` (docs/enterprise/qualitaet-und-lieferkette.md). Thresholds sit a
    // little below the measured values; raise them when coverage grows, never lower them silently.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Command-line entry points (seed, load test, CLIs) run outside the test suite.
      exclude: ['src/main.ts', 'src/db/seed.ts', 'src/db/loadtest.ts', 'src/db/*-cli.ts', 'src/db/rotate-key.ts', 'src/jobs/run-once.ts'],
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // Measured on 13.10.2026: statements 90.1 %, branches 77.6 %, functions 94.0 %, lines 94.0 %.
      thresholds: { statements: 88, branches: 75, functions: 92, lines: 92 },
    },
    hookTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://ideenportal:ideenportal@localhost:5432/ideenportal_test',
      MAIL_TRANSPORT: 'none',
      SECRET_KEY: 'test-secret-key-for-vitest-only',
      // Tests log in many times from one address; the rate-limit test sets the factor back to 1.
      RATE_LIMIT_FACTOR: '100',
      // No real network in tests: the page fetch of the source check uses fakes (R2-46).
      AI_PAGE_FETCH: 'false',
    },
  },
});

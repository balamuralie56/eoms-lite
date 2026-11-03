import { createHmac } from 'node:crypto';
import { defineConfig } from '@playwright/test';

// A real Supabase anon key is a JWT (role "anon") signed with the project secret and sent by supabase-js as
// "Authorization: Bearer <key>". The local PostgREST verifies it, so the local stack needs the same kind of key.
const JWT_SECRET = 'e2e-only-jwt-secret-0123456789abcdef0123456789';
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function anonKey(): string {
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u({ role: 'anon', iss: 'local-test-stack', iat: 1_700_000_000, exp: 4_102_444_800 });
  return `${head}.${body}.${createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

/**
 * Browser tests against the REAL frontend build, the REAL RPC functions, REAL PostgREST and REAL PostgreSQL (Docker).
 * Authentication is a local stand-in (NOT Supabase Auth). Prerequisite (repo root): `npm run stack:up`.
 * Browser: the system Google Chrome (no browser download). Mobile = Chrome device emulation, NOT real iPhone Safari.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,                       // one shared database
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://127.0.0.1:4173', channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure', acceptDownloads: true },
  projects: [
    { name: 'desktop', testIgnore: /mobile\.spec\.ts/, use: { viewport: { width: 1366, height: 800 } } },
    { name: 'mobile', testMatch: /mobile\.spec\.ts/, use: { viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: [
    {
      command: 'node ../tools/local-stack/server.mjs --local-test-stack',
      url: 'http://127.0.0.1:54321/__test/health', reuseExistingServer: true, timeout: 30_000,
    },
    {
      command: 'npm run build:e2e && node e2e/serve-dist.mjs',
      url: 'http://127.0.0.1:4173/', reuseExistingServer: false, timeout: 120_000,
      env: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: anonKey() },
    },
  ],
});

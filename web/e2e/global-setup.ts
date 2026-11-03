import { Client } from 'pg';

/** Fails fast with an actionable message if the local Docker stack is not up. */
export default async function globalSetup() {
  const db = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/eoms_e2e';
  const c = new Client({ connectionString: db });
  try { await c.connect(); await c.query('select 1 from public.app_branding'); }
  catch (e) { throw new Error(`E2E database not ready (${(e as Error).message}). Run "npm run stack:up" in the repository root first.`, { cause: e }); }
  finally { await c.end().catch(() => undefined); }
  const r = await fetch('http://127.0.0.1:3010/rpc/get_public_config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  if (!r || !r.ok) throw new Error('PostgREST is not reachable on :3010. Run "npm run stack:up" in the repository root first.');
}

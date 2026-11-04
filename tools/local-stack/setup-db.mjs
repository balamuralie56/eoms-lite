// Creates (or recreates) the local E2E database `eoms_e2e` from the REAL migrations + the test-only Supabase shim,
// and the `authenticator` role PostgREST connects with. LOCAL ONLY: throwaway credentials, refuses non-local hosts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(ADMIN_URL)) {
  console.error('refusing to run against a non-local database:', ADMIN_URL.replace(/:[^:@/]+@/, ':***@'));
  process.exit(1);
}
const withDb = (db) => { const u = new URL(ADMIN_URL); u.pathname = '/' + db; return u.toString(); };

const NAME = process.env.EOMS_DB_NAME || 'eoms_e2e';
if (!/^[a-z0-9_]+$/.test(NAME)) { console.error('invalid EOMS_DB_NAME'); process.exit(1); }

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const exists = (await admin.query('select 1 from pg_database where datname = $1', [NAME])).rows.length > 0;
  // the throwaway test database is recreated every time; any OTHER (long-lived demo) database is never dropped without --recreate
  if (exists && NAME !== 'eoms_e2e' && !process.argv.includes('--recreate')) {
    console.error(`database ${NAME} already exists. Refusing to drop it. Pass --recreate to wipe it deliberately.`);
    process.exit(1);
  }
  await admin.query(`drop database if exists ${NAME} with (force)`);
  await admin.query(`create database ${NAME}`);
  await admin.end();

  const db = new pg.Client({ connectionString: withDb(NAME) });
  await db.connect();
  await db.query(fs.readFileSync(path.join(root, 'tests', 'db', '00_supabase_shim.sql'), 'utf8'));
  const dir = path.join(root, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await db.query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  await db.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticator') then
        create role authenticator login password 'authpass' noinherit;
      end if; end $$;
    grant anon, authenticated to authenticator;
    grant usage on schema public to authenticator;`);
  await db.end();
  console.log(NAME + ' ready (migrations applied: ' + fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).length + ')');
}
main().catch((e) => { console.error(e); process.exit(1); });

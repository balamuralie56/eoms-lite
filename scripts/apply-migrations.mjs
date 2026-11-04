// Applies supabase/migrations/*.sql, in order, to a Supabase project's database. Each file runs in its own transaction.
//
//   (PowerShell)  $env:SUPABASE_DB_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
//                 node scripts/apply-migrations.mjs            # DRY RUN: shows what would be applied
//                 node scripts/apply-migrations.mjs --yes      # applies it
//
// The connection string is read ONLY from the environment (never an argument, never printed, never stored).
// Use the "Session pooler" string from Supabase -> Connect (IPv4 friendly), port 5432.
//
// Safety:
//  * refuses anything that does not look like a Supabase database (needs roles anon/authenticated/service_role and auth.uid()),
//  * refuses a local database unless --allow-local (used by the test suite's shim),
//  * keeps a ledger in the non-exposed schema eoms_private; an already-applied file whose content has since changed is a hard stop,
//  * stops at the first error with the transaction rolled back (nothing half-applied).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pg = createRequire(path.join(root, 'package.json'))('pg');

const args = new Set(process.argv.slice(2));
const apply = args.has('--yes');
const allowLocal = args.has('--allow-local');
const url = process.env.SUPABASE_DB_URL;
const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };

if (!url) fail('Set SUPABASE_DB_URL in the environment (see the header of this script). It is never accepted as an argument.');
let u;
try { u = new URL(url); } catch { fail('SUPABASE_DB_URL is not a valid connection string.'); }
const local = /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
if (local && !allowLocal) fail('This is a local database. Pass --allow-local only for tests.');
if (!local && !/(^|\.)supabase\.(co|com)$/.test(u.hostname)) fail(`Host "${u.hostname}" is not a Supabase host. Refusing.`);

const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  const roles = (await client.query(`select rolname from pg_roles where rolname in ('anon','authenticated','service_role')`)).rows.length;
  const authUid = (await client.query(`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'auth' and p.proname = 'uid'`)).rows.length;
  if (roles !== 3 || !authUid) fail('This does not look like a Supabase database (missing anon/authenticated/service_role roles or auth.uid()).');

  await client.query(`create schema if not exists eoms_private`);
  await client.query(`create table if not exists eoms_private.applied_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);

  const dir = path.join(root, 'supabase', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Map((await client.query('select name, sha256 from eoms_private.applied_migrations')).rows.map((r) => [r.name, r.sha256]));
  console.log(`target: ${u.hostname}${u.username ? ` (user ${u.username.split('.')[0]}${u.username.includes('.') ? '.' + u.username.split('.')[1] : ''})` : ''}`);

  const pending = [];
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const sha = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    if (done.has(f)) {
      if (done.get(f) !== sha) fail(`${f} was already applied but its content has changed since. Never edit an applied migration; add a new one.`);
      console.log(`  already applied  ${f}`);
    } else pending.push({ f, sql, sha });
  }
  if (!pending.length) { console.log('Nothing to do: every migration is applied.'); process.exit(0); }
  for (const p of pending) console.log(`  ${apply ? 'applying' : 'would apply'}  ${p.f}`);
  if (!apply) { console.log('\nDry run. Re-run with --yes to apply.'); process.exit(0); }

  for (const p of pending) {
    try {
      await client.query('begin');
      await client.query(p.sql);
      await client.query('insert into eoms_private.applied_migrations (name, sha256) values ($1, $2)', [p.f, p.sha]);
      await client.query('commit');
      console.log(`  ok               ${p.f}`);
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      fail(`${p.f} failed and was rolled back: ${e.message}`);
    }
  }
  console.log('\nAll migrations applied. Next: create the first administrator (scripts/bootstrap_admin.sql), then run scripts/verify-deployment.mjs.');
} finally {
  await client.end().catch(() => undefined);
}

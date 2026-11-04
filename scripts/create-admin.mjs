// Makes an existing Supabase Auth user an EOMS Lite administrator (or deactivates one).
//
//   1. Supabase dashboard -> Authentication -> Users -> Add user -> "Create new user": email + strong password, tick "Auto Confirm User".
//   2. (PowerShell, same window where SUPABASE_DB_URL is set)
//        node scripts/create-admin.mjs admin@your-institution.example "First Admin"
//        node scripts/create-admin.mjs admin@your-institution.example --deactivate
//
// Reads the connection string from the environment only. Never creates auth users or passwords: the user must already exist.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pg = createRequire(path.join(root, 'package.json'))('pg');
const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };

const argv = process.argv.slice(2);
const deactivate = argv.includes('--deactivate');
const allowLocal = argv.includes('--allow-local');
const [email, displayName] = argv.filter((a) => !a.startsWith('--'));
const url = process.env.SUPABASE_DB_URL;

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Usage: node scripts/create-admin.mjs <email> ["Display Name"] [--deactivate]');
if (!url) fail('Set SUPABASE_DB_URL in the environment (Session pooler connection string). It is never accepted as an argument.');
let u;
try { u = new URL(url); } catch { fail('SUPABASE_DB_URL is not a valid connection string.'); }
const local = /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
if (local && !allowLocal) fail('This is a local database. Pass --allow-local only for tests.');
if (!local && !/(^|\.)supabase\.(co|com)$/.test(u.hostname)) fail(`Host "${u.hostname}" is not a Supabase host. Refusing.`);

const client = new pg.Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
await client.connect();
try {
  const ready = await client.query(`select to_regclass('public.admins') as t`);
  if (!ready.rows[0].t) fail('public.admins does not exist: apply the migrations first (node scripts/apply-migrations.mjs --yes).');

  const found = await client.query('select id, email, email_confirmed_at from auth.users where lower(email) = lower($1)', [email]);
  if (found.rows.length !== 1) fail(`No Supabase Auth user with email ${email}. Create it first: Authentication -> Users -> Add user.`);
  const user = found.rows[0];

  if (deactivate) {
    const r = await client.query('update public.admins set is_active = false where user_id = $1 returning email', [user.id]);
    if (!r.rowCount) fail(`${email} is not an administrator.`);
    console.log(`Deactivated ${email}. It takes effect on their next request.`);
  } else {
    if (!user.email_confirmed_at) console.warn('WARNING: this user has not confirmed their email, so they may be unable to sign in. Tick "Auto Confirm User" when creating users in the dashboard.');
    const name = (displayName || email.split('@')[0]).trim();
    await client.query(
      `insert into public.admins (user_id, email, display_name, is_active) values ($1, $2, $3, true)
       on conflict (user_id) do update set email = excluded.email, display_name = excluded.display_name, is_active = true`,
      [user.id, user.email, name]);
    console.log(`${email} is now an active administrator (${name}).`);
  }
  const all = await client.query('select email, display_name, is_active from public.admins order by created_at');
  console.log('\nAdministrators:');
  for (const a of all.rows) console.log(`  ${a.is_active ? 'active  ' : 'inactive'}  ${a.email}  (${a.display_name})`);
} finally {
  await client.end().catch(() => undefined);
}

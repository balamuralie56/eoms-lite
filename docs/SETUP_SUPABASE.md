# Setting up a fresh Supabase project

Use a **new** project for EOMS Lite. Never reuse the production EOMS project, its keys, URL or database.
Verify current Supabase free-tier terms yourself (project pause on inactivity, connection/request limits); they are
not assumed here.

## 1. Create the project

1. Supabase dashboard -> New project (free plan). Choose a region close to the campus. Save the database password in
   your password manager (it is never committed or put in the frontend).
2. Settings -> API: note the **Project URL** and the **anon (public)** key. These two are the only values the
   frontend will ever hold. **Do not** put the `service_role` key anywhere in browser code or this repo.
3. Settings -> API -> *Exposed schemas*: keep only `public`. `eoms_private` must **not** be exposed.

## 2. Deploy the migrations

Apply all ten (0001-0010) in order. Do **not** apply `tests/db/00_supabase_shim.sql` (test-only).
A project that already has an earlier set only needs the later files.

**Option 0: the migration runner (recommended).** `node scripts/apply-migrations.mjs --yes` with `SUPABASE_DB_URL` set to the *Session pooler* string (see DEPLOYMENT.md §1). Tested locally: refusals, idempotent re-run, changed-file detection, rollback on a failing migration.

**Option A: SQL editor.** Paste and run, in order: `0001_schema.sql`, `0002_functions.sql`,
`0003_security.sql`, `0004_admin_schema.sql`, `0005_admin_config_functions.sql`, `0006_import_functions.sql`,
`0007_admin_security.sql`, `0008_settings_maintenance.sql`, `0009_admin_read_functions.sql`, `0010_product_security.sql` (all under `supabase/migrations/`). Run each as one script and stop at the first error.

**Option B: Supabase CLI** (not installed here; install per Supabase docs):

```
supabase login
supabase link --project-ref <your-new-project-ref>
supabase db push
```

Run migrations against the new project only. Check the project ref twice; there is no "undo".

## 3. Create the first admin (bootstrap)

1. Authentication -> Users -> Add user (email + strong password; disable public sign-ups under Authentication ->
   Providers/Settings so strangers cannot create accounts).
2. Copy that user's UUID, then in the SQL editor:

```sql
insert into public.admins (user_id, email, display_name)
values ('<uuid-from-auth-users>', 'admin1@example.org', 'Admin One');
```

One row per named admin. Deactivate with `update public.admins set is_active = false where user_id = '...'`.
Note: an authenticated user who is not in `admins` can sign in but sees no data and cannot run admin functions.

## 4. Smoke test on the real project (required; not yet performed on a real project)

Quickest: `node scripts/verify-deployment.mjs` (see its header; 29 checks, passed against the local stack). The manual curl versions follow.

The automated tests run on plain PostgreSQL with a shim, so they do not cover PostgREST, Supabase Auth or the pooler.
After deploying, verify manually (replace `<url>`/`<anon>`):

```
# anonymous status call works
curl -s -X POST "<url>/rest/v1/rpc/get_checkin_status" -H "apikey: <anon>" -H "Authorization: Bearer <anon>" -H "Content-Type: application/json" -d "{}"

# anonymous direct table read must be denied (expect permission denied / 401/403)
curl -s "<url>/rest/v1/schedule?select=*" -H "apikey: <anon>" -H "Authorization: Bearer <anon>"

# anonymous admin function must be denied
curl -s -X POST "<url>/rest/v1/rpc/admin_release" -H "apikey: <anon>" -H "Authorization: Bearer <anon>" -H "Content-Type: application/json" -d "{\"p_allocation_id\":\"00000000-0000-0000-0000-000000000000\",\"p_reason\":\"test\"}"
```

Also confirm: a signed-in non-admin can call nothing privileged; an admin JWT can call `is_admin`; and check what
`current_setting('request.headers')` contains for the client-IP throttle.

Phase 2A additions to the smoke test (all still **not performed** on a real project):

* An anonymous call to any `admin_*` function (for example `admin_create_room`) must be denied; the same call with a
  signed-in **non-admin** token must return `not authorized`; with an **admin** token it must succeed and write an audit row.
* Confirm the Data API accepts the RPC parameter shapes used by the tests (named parameters over JSON, `jsonb` rows,
  `null` for defaults) and that a 500-row `admin_import_add_rows` body is accepted by the platform.
* Check that `audit_log` cannot be modified from the dashboard's API roles.

## 5. Configure and load data (Phase 2A: through audited RPCs)

With an admin JWT, in this order: `admin_create_session` (IST local times), `admin_create_room`,
`admin_assign_room_to_session` (invigilator capacity), then the schedule through
`admin_import_begin` -> `admin_import_add_rows` -> `admin_import_validate` -> `admin_import_commit`.
See `ADMIN_CONFIGURATION.md` and `SCHEDULE_IMPORT.md`. Until the Phase 2B UI exists these can be called from the
SQL editor with `set local role authenticated` and a `request.jwt.claims` setting, or from any client holding an admin JWT.
Direct inserts as project owner still work but are not audited.

New import limits live in `app_settings` (`import_max_rows`, `import_chunk_max_rows`, `import_max_file_bytes`).

## 6. Local test database

```
npm install
npm run db:up      # postgres:17 on 127.0.0.1:54329 (throwaway)
npm test
npm run db:down
```
Requires Docker and Node 22+.

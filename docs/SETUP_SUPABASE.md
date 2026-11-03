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

Apply in order. Do **not** apply `tests/db/00_supabase_shim.sql` (test-only).

**Option A: SQL editor (simplest).** Paste and run, in order:
`supabase/migrations/0001_schema.sql`, then `0002_functions.sql`, then `0003_security.sql`.

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

## 4. Smoke test on the real project (required; not yet performed)

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

## 5. Seed data (Phase 1, by SQL as project owner)

Insert `exam_sessions`, `rooms`, `session_rooms`, `schedule` rows with the SQL editor (see `tests/db/harness.js`
for a worked example of each insert). Phase 2 replaces this with audited admin RPCs and the import UI.

## 6. Local test database

```
npm install
npm run db:up      # postgres:17 on 127.0.0.1:54329 (throwaway)
npm test
npm run db:down
```
Requires Docker and Node 22+.

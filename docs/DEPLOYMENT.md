# Deployment guide (Cloudflare Pages + Supabase, free tier)

**Status: NOT deployed.** No Supabase project, Cloudflare account or domain was available to this work. Everything below is
instructions; nothing here has been executed against real services. Each step says what to verify. See
`TESTING.md` for exactly what has and has not been tested.

## 0. What you need

| Item | Notes |
|---|---|
| A **new** Supabase project (free) | Never reuse another system's project. Region near the campus. |
| A Cloudflare account (free) with Pages | Or any static host that supports SPA fallback + custom headers. |
| A domain you control | A stable HTTPS address is what the permanent QR code points to. Cloudflare Pages also gives `*.pages.dev` (HTTPS) which can serve as the address if you have no domain. |
| Node 22+ (24 used here) | Only to build, or let Cloudflare build it. |

## 1. Supabase project

1. Create the project (free plan). Save the database password in a password manager.
2. **Settings -> API**: copy the *Project URL* and the *anon public* key. Those two values are the only configuration the
   frontend receives. **Never** put the `service_role` key in the frontend, in Git, or in Cloudflare variables.
3. **Settings -> API -> Exposed schemas**: only `public`. `eoms_private` must NOT be exposed.
4. **Authentication -> Sign In / Providers**: turn **off** "Allow new users to sign up" (administrators are created by hand).
   Keep email+password enabled. Under *URL configuration* set the site URL to your final address.
5. Apply the migrations **in order** with the runner (recommended):
   * Supabase dashboard -> **Connect** -> copy the **Session pooler** connection string (IPv4 friendly, port 5432) and fill in the database password.
   * In PowerShell: `$env:SUPABASE_DB_URL = '<that string>'` then `node scripts/apply-migrations.mjs` (dry run) and `node scripts/apply-migrations.mjs --yes`.
   * The string is read from the environment only. The runner refuses non-Supabase hosts, applies each file in its own transaction, rolls back on error, records a ledger in the non-exposed `eoms_private` schema, and stops if an already-applied file has changed.
   * Alternatives: paste each file from `supabase/migrations/` into the SQL editor in order, or `supabase link` + `supabase db push`.
   Do **not** apply `tests/db/00_supabase_shim.sql` (test-only).
6. Create the first administrator: add the user in the dashboard (Authentication -> Users -> Add user -> Create new user, tick *Auto Confirm User*), then run `node scripts/create-admin.mjs <email> "<Display Name>"` (same environment as step 5; it looks the user up by email). Manual alternative: `scripts/bootstrap_admin.sql`. Deactivate with `--deactivate`.
7. (Recommended) schedule maintenance with pg_cron: Database -> Extensions -> enable `pg_cron`, then
   `select cron.schedule('eoms-maintenance', '17 * * * *', $$select eoms_private.run_maintenance()$$);`
   Maintenance removes expired throttle records and abandoned import staging. **It never deletes audit records.** Without
   pg_cron an administrator can press *Settings -> Run maintenance now*.
8. Run the smoke test: set `SUPABASE_URL`, `SUPABASE_ANON_KEY` (and optionally `ADMIN_EMAIL`/`ADMIN_PASSWORD`), then `node scripts/verify-deployment.mjs`. It checks (read-only) that anonymous users cannot read any table or call any admin function, that `eoms_private` is not exposed, that the key is the anon key (it refuses `service_role`), and, with admin credentials, that sign-in works and whether a **client-IP header reaches the database**. **Do not call this deployment verified until it passes on the real project.** (Passed 29/29 against the local test stack only.)
   verified until that has passed on the real project.**

### Free-tier facts that matter (checked on supabase.com, Nov 2026; re-check before relying on them)

| Fact | Consequence for exam day |
|---|---|
| Free projects are **paused after 1 week of inactivity** | A project idle for a week before the exam may be paused. **Open the dashboard and make sure the project is Active the day before; make a test check-in on the morning.** Upgrading to Pro prevents pausing (a business decision, not made here). |
| **No automatic backups** on Free | Export the schedule, allocations and audit log (admin Reports/Audit exports) after every session, and keep the SQL migrations. See the runbook. |
| 500 MB database, 5 GB egress, "unlimited" API requests, 50,000 MAU | Far above this system's needs (about 500 check-ins per session). |
| Default API statement timeouts: **`anon` 3 s, `authenticated` 8 s** (Supabase docs) | `checkin` waits at most 2 s for the session lock, so it always answers within the 3 s anon budget (as `BUSY`, which the page retries). A 5000-row import commit must finish within 8 s: measured 0.3 s locally; **unmeasured on Supabase's shared CPU**. If a commit ever times out it rolls back and can be retried. |
| Connection/pooler limits for Free are **not published** on the pricing page | Not verified. The load plan below measures instead of assuming. |

## 2. Frontend build and Cloudflare Pages

Environment variables (build time; both are public by design):

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the anon public key |

Cloudflare Pages -> *Create project -> Connect to Git* (or upload `web/dist`):

| Setting | Value |
|---|---|
| Root directory | `web` |
| Build command | `npm ci && npm run build` |
| Output directory | `dist` |
| Node version | 22 or newer (`NODE_VERSION` variable) |

`web/public/_redirects` (`/* /index.html 200`) provides SPA routing for deep links such as `/admin/audit`;
`web/public/_headers` sets the security headers, **including a Content-Security-Policy whose `connect-src` allows only the site
itself and `https://*.supabase.co`**. If you front Supabase with a custom domain, add it to `connect-src`.
The E2E suite serves the real build with these same headers and rewrites, which is how a CSP bug (QR download using `fetch`) was caught.

## 3. Domain and HTTPS

1. Pages project -> *Custom domains* -> add e.g. `checkin.your-institution.edu`. Cloudflare issues the certificate.
2. Open `https://<domain>/` **on a phone using mobile data** (not campus Wi-Fi) and confirm: the padlock, the check-in page, status line.
3. Open `https://<domain>/admin/login` and sign in with a named admin account.
4. The address must not change after the QR is printed. Prefer a domain you own over `*.pages.dev`.

## 4. Permanent QR code (only after step 3 passes)

Settings page -> *Permanent QR code* (tick the verification box, download), or
`node scripts/generate-qr.mjs https://<domain> --verified`. The code encodes exactly the address, nothing else (a test decodes it).
Scan the printed sheet with two different phones (iPhone camera and Android camera) before printing in bulk.
**No QR asset has been generated or committed**, because no verified production address exists yet.

## 5. Abuse protection

* Implemented and tested: per-client throttle in the database (`RATE_LIMITED`), bounded client retries, 2 s lock timeout.
* **Unverified assumption:** the throttle keys on `cf-connecting-ip`, else the **right-most** `X-Forwarded-For` entry (the left-most is
  client-controlled and is ignored). Which header Supabase passes to the database must be confirmed: after deploying, sign in,
  open *Settings -> Maintenance and diagnostics -> Inspect request headers* and check that a real client IP header is present.
  If none is, the throttle is inactive (integrity is unaffected).
* **Not configured:** Cloudflare WAF rate-limiting rules and Turnstile. Requests go from the browser **directly to Supabase**, so a
  Cloudflare rule on the Pages domain does not protect the API; Turnstile would need a server-side verifier (an Edge Function). If
  abuse becomes a concern, that is the recommended next step. **Do not claim it is active.**

## 6. Deployment checklist

- [ ] Migrations 0001-0010 applied without error; `select count(*) from public.admins` shows the named admins.
- [ ] Sign-ups disabled; `service_role` key nowhere in the repo, Cloudflare variables or browser.
- [ ] Anonymous cannot read tables (`/rest/v1/schedule` -> 401/403) and cannot call `admin_*` (smoke test).
- [ ] Site served over HTTPS on the final domain; CSP header present (`curl -I`); deep link `/admin/audit` loads.
- [ ] Branding (institution, exam-cell name, contact text, logo) configured in Settings.
- [ ] Sessions, rooms (per-session invigilator capacity) and schedule imported; dashboard numbers match the source sheets.
- [ ] Request-header diagnostic checked; pg_cron maintenance scheduled or a person assigned to run it.
- [ ] Rehearsal: a dry-run session with real phones (see `EXAM_DAY_RUNBOOK.md`), then **delete rehearsal data** or use a separate project.
- [ ] Project is Active (not paused) the day before; backups exported.
- [ ] QR generated from the verified address and test-scanned.

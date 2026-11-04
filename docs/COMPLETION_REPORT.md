# EOMS Lite: completion report

Date: 2026-11-04. Repository: `B:\Projects\FDAI MAIN\eoms-lite` (independent; the older EOMS was never touched).

## Verdict (plain)

The product is **built and works end to end on a local replica of the architecture**: 256 automated tests pass, including 42 in a real browser
against the real PostgREST engine and the real database. It is **not deployed**, and it has **never run on a real Supabase project, Cloudflare Pages,
a real domain, or iPhone Safari**. Those are external steps only you can do; the exact list is at the end. Per the definition of done, the items that depend on
them (Supabase staging verified, hosting/domain deployed, QR generated from a verified production URL) are **not done**, and nothing here claims otherwise.

## 1. Features implemented

* **Employee**: permanent-URL check-in page; Employee ID only; server-side session detection (`[opens, closes)`, no fallback); schedule validation; random
  round-based allocation; idempotent retries; all 10 result codes handled in plain language (BUSY retried with bounded exponential backoff + jitter); prominent room;
  **PNG slip** (1800×1100, branding, long-text safe); "back" never re-allocates.
* **Admin portal** (named accounts, database-checked): dashboard with real numbers and a live room monitor; sessions (IST, overlap refused, confirmations, reasons); rooms with
  per-session **invigilator** capacity; schedule table + **CSV/XLSX import wizard** (Web Worker, 500-row chunks, retry/resume, dry run, validate, conflict decision, commit, report,
  separate confirmed replace); allocations (search, move, release, history, re-entry); verification (flags, clear/block); late authorization; audit viewer; 9 reports with CSV/XLSX export;
  settings/branding/logo; permanent-QR tool; maintenance and request-header diagnostic.
* **Rules enforced in PostgreSQL**: advisory-lock serialisation per session, unique active allocation, capacity trigger, immutable allocations and audit, overlap exclusion constraint.

## 2. Database changes (this milestone)

Migrations **0008** (branding, retention/maintenance, client-IP hardening), **0009** (12 read/report RPCs), **0010** (RLS/grants). Earlier migrations 0001-0007 unchanged.
Public surface is now exactly `checkin`, `get_checkin_status`, `get_public_config`; 40 `admin_*` functions. Two catalog tests were updated to the new intended counts (documented in the commit).

## 3. Frontend routes

`/`, `/admin/login`, `/admin`, `/admin/sessions`, `/admin/rooms`, `/admin/schedule`, `/admin/allocations`, `/admin/verification`, `/admin/audit`, `/admin/reports`, `/admin/settings`, plus not-found.

## 4. Security measures

RLS default-deny; `SECURITY DEFINER` functions with empty `search_path`; admin identity only from the JWT; deactivated admins cut off on the next request; left-most `X-Forwarded-For` ignored;
CSP and security headers; React escaping; SVG logos refused; file magic-byte checks; formula-injection neutralisation in CSV and XLSX; no employee data in browser storage; audit append-only;
retention that never deletes audit. Documented, **unsolved by design**: Employee ID is not authentication (administrator-assisted verification instead). Details: `SECURITY_MODEL.md`.

## 5-6. Automated and integration test results (final run)

| Suite | Result |
|---|---|
| PostgreSQL (real PG 17) | **113 / 113** |
| Data API through real PostgREST | **11 / 11** |
| Frontend unit + component (component tests use a mocked API) | **90 / 90** |
| Browser (real Chrome, production build + real CSP) | **42 / 42** (38 desktop + 4 mobile-emulated) |
| ESLint / TypeScript / production build | 0 problems / 0 errors / OK |

"Integration" here means PostgREST + PostgreSQL + the real frontend with a **stand-in for Supabase Auth**. **No integration test against real Supabase exists.** See `TESTING.md` for the full list
including seven defects found and fixed during testing.

## 7. Performance

Measured locally only (not Supabase): 100 simultaneous: p95 388 ms; 200 simultaneous: p95 869 ms; 200 repeats of one ID: 1 allocation; 250 into 150 slots: exactly 150 + 100 `ROOMS_FULL`;
500 paced over 60 s: p95 21 ms; zero duplicates, zero over-capacity, zero errors in all. **Supabase performance: not tested.** Verified free-tier facts and the estimate that a burst on shared CPU might
produce some `BUSY` retries are in `PERFORMANCE.md`.

## 8. Deployment status

**Not deployed.** Instructions: `DEPLOYMENT.md`. A GitHub Actions workflow is written but unrun. **No QR asset exists**; the generator (`scripts/generate-qr.mjs`, and the Settings tool) refuses to run unverified or on http.

## 9. Outstanding external dependencies

A real Supabase project; a Cloudflare Pages project and a domain with HTTPS; named administrator e-mail accounts; real schedule files; physical phones (iPhone and Android) for the smoke test and QR scan.

## 10. Known limitations

1. Real Supabase behaviour (Auth, gateway headers, pooler, shared-CPU latency, pausing) untested; the throttle depends on an **unverified** client-IP header (diagnostic provided).
2. **Free plan pauses after a week idle and has no backups**: operational procedures in the runbook; Pro would remove the pause (cost decision not made).
3. No Cloudflare/Turnstile edge protection (the browser calls Supabase directly).
4. iPhone Safari/WebKit and Firefox untested; no automated accessibility audit; no penetration test.
5. PNG slip is editable; no verification code by design.
6. No undo/removal of committed schedule rows (replace-conflicts only); owner SQL is unaudited.
7. Slash/dot dates are read day-first; Excel serials in the *date* column are converted, elsewhere numbers are kept as typed (leading zeros in numeric IDs are lost by Excel itself).
8. The allocation is serialised per session by design; a very large burst may show short `BUSY` retries.
9. XLSX reading covers the first sheet only; very large files are bounded by 5 MB / 5000 rows.

## 11. Exact steps you must do manually

1. Create a **new** Supabase project; apply `supabase/migrations/0001...0010`; create the first admin with `scripts/bootstrap_admin.sql`; disable sign-ups. (`DEPLOYMENT.md` §1.)
2. Run the smoke test in `SETUP_SUPABASE.md` §4 and *Settings -> Inspect request headers*; tell me the result and I will adjust the throttle header if needed.
3. Create the Cloudflare Pages project (`web`, `npm ci && npm run build`, output `dist`, the two `VITE_*` variables), add your domain, confirm HTTPS on a phone over mobile data. (§2-3.)
4. Run the load plan on staging (`PERFORMANCE.md` §5) and a rehearsal session with real phones; record the results.
5. Only then generate the QR (`node scripts/generate-qr.mjs https://<domain> --verified` or Settings), scan with two phones, print.
6. Decide the open business items: free plan vs a Pro tier for the exam window; whether to add Turnstile; who runs maintenance; data-retention values.
7. Push to GitHub when you approve (nothing from this milestone has been pushed).

## Update 2026-11-04: first verification on the REAL Supabase project

Project `kuoydzarndvjoroqzqsk` (region ap-south-1). Performed by the owner with `scripts/apply-migrations.mjs`, `scripts/create-admin.mjs` and
`scripts/verify-deployment.mjs`:

* Migrations 0001-0010 applied without error; first administrator created.
* Smoke test: **28 / 29 passed**. The one failure was the script's own key check, which did not yet recognise Supabase's newer
  `sb_publishable_...` key format (fixed: publishable keys accepted, `sb_secret_...` and `service_role` keys refused).
  - Anonymous access refused for all 14 tables and all admin functions; `eoms_private` not exposed (HTTP 406).
  - Real Supabase Auth sign-in works; the database recognises the admin (`is_admin` = true); `admin_overview` answers.
  - **Client-IP header verified:** Supabase passes `cf-connecting-ip` (also `x-forwarded-for`, `sb-forwarded-for`) to the database, so the abuse
    throttle is active. `cf-connecting-ip` is set by Cloudflare at Supabase's edge; that it carries the end user's address (not a proxy's) is
    expected but was not separately confirmed from two networks.

Still not done on the real project: frontend deployment (Cloudflare Pages + domain), the frontend running against this project (it should accept the
publishable key with supabase-js 2.118, untested), load testing, a rehearsal, and the QR code.

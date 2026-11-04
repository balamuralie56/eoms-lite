# Testing

All numbers below come from the final full run on the author's Windows 11 machine (Node 24, Docker Desktop, Google Chrome).
**No test has been run against a real Supabase project.**

| Suite | Command | What it exercises | Result |
|---|---|---|---|
| **PostgreSQL** (`tests/db`) | `npm test` | Real PostgreSQL 17 in Docker. Schema constraints, the allocation engine and its invariants, concurrency (advisory lock, duplicates, capacity), RLS/grants, every admin RPC, imports, settings, reports, retention. A test-only shim stands in for Supabase's `auth` schema and roles. | **113 / 113 pass** |
| **Data API** (`tests/api`) | `npm run test:api` | The real **PostgREST** engine in Docker in front of the same database: JSON parameter shapes, HTTP status mapping, JWT checks, request headers, 500-row chunks, a 5000-row import, 100 simultaneous requests. Auth is a **stand-in**, not Supabase Auth. | **11 / 11 pass** |
| **Frontend unit + component** (`web/tests`) | `cd web && npm test` | Pure logic (retry/backoff, result messages, CSV/XLSX parsing, formula neutralisation, slip layout, IST helpers, upload retry/resume) and React components. Component tests use a **mocked API layer** (clearly labelled in the file). | **90 / 90 pass** |
| **Browser (Playwright)** | `npm run stack:up` (repo root) then `cd web && npm run e2e` | The **production build** served with the real `_headers` (CSP) and SPA fallback, in real Chrome, against PostgREST + PostgreSQL. Public check-in, slip PNG download, admin auth, sessions, rooms, import (CSV, XLSX, retry), verification, late authorization, re-entry, reassignment, audit, reports/exports, settings, QR, maintenance. | **42 / 42 pass** (38 desktop, 4 mobile-emulated) |
| Static checks | `cd web && npm run lint && npm run typecheck && npm run build` | ESLint (React hooks rules), TypeScript strict, production build | 0 lint problems, 0 type errors, build OK (≈431 kB JS, 131 kB gzip) |

Total automated tests: **256**.

## How to run everything

```
npm install && npm run stack:up        # Docker: PostgreSQL 17 + PostgREST (local, throwaway credentials)
npm test && npm run test:api
cd web && npm install
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e                            # builds dist-e2e, starts the stand-in front door, drives Chrome
```

## What the tests prove (selected)

* **Allocation invariant** under 200 simultaneous requests: zero duplicates, zero over-capacity, every allocation went to a minimum-count room (replayed in order). Disabling the advisory lock makes all 6 Phase 1 concurrency tests and 6 of the 7 admin concurrency tests fail (checked by temporarily no-op-ing the lock, then restoring it), so they do detect races.
* **No public data**: anonymous clients cannot read any table or call any `admin_*` function (catalog test + HTTP test); signed-in non-admins and deactivated admins are refused inside every RPC; the browser guard is shown to be only a convenience.
* **Session loss**: an admin deactivated, or whose token is rejected, while a page is open is signed out by the page's own background refresh (a defect found and fixed during this work).
* **Import**: dry run leaves the live schedule untouched; invalid rows block commit; conflicts need an explicit decision; replacement is separate, confirmed, and audited with before/after; a lost response and four consecutive failed chunks are retried without duplicating rows and the upload resumes; 5001 rows are refused before any request.
* **Exports**: CSV and XLSX contain the selected filter's rows only, include date and session, and text starting with `=`, `+`, `-`, `@` is prefixed with an apostrophe (checked by reading the downloaded files).
* **QR**: the downloaded PNG is decoded in a test and contains exactly the entered address.
* **Slip**: the downloaded PNG is 1800×1100, has the right file name, a navy header band, drawn room code and details, and **no ink at the right edge** for an extremely long name/department.

## Defects the tests found (and that are fixed)

1. A polling failure (401/403) was swallowed, so an expired or revoked admin was never signed out while a page stayed open.
2. The QR download used `fetch('data:...')`, which the production CSP (`connect-src`) blocks; found only because E2E serves the real headers.
3. Sign-in could clear the "session expired" notice through a race between overlapping session evaluations.
4. A first import-validation query took ≈32 s for 5000 rows (planner re-evaluated a subquery per row); rewritten to ≈0.3 s.
5. The default "working session" in the admin picked the first upcoming session in list order, not the earliest.
6. Contact text configured by the admin was lower-cased when spliced into sentences; now shown verbatim.
7. A DB test used a fixed exam date and began failing after midnight IST (test fragility, fixed).

## Not tested / limits of what is claimed

* **Real Supabase** (Auth, the API gateway, pooler, free-tier behaviour, `request.headers` content): not tested. The stand-in auth issues HS256 JWTs the same way, but GoTrue, refresh behaviour and email flows are not exercised.
* **iPhone Safari / WebKit and Firefox**: not tested (only Chrome; "mobile" = Chrome device emulation at 375×667). The slip download and press-and-hold fallback on real iOS are unverified.
* Accessibility: semantic markup, labels, focus handling and contrast were designed in but **no automated axe/screen-reader audit** was run.
* Cloudflare Pages deployment, custom domain, HTTPS certificate, and the CSP on the real host: not tested (the same headers were tested locally).
* GitHub Actions CI file is written but **has not been run** on GitHub.
* Performance on Supabase: see `PERFORMANCE.md`.

# EOMS Lite

Lightweight, QR-based invigilator room allocation. Independent of the production EOMS.

**Status: complete product, tested locally; not yet deployed and not yet run on a real Supabase project.**
Employee check-in page with PNG slip, protected admin portal, schedule import, reports, audit, settings, permanent-QR tool. See docs/COMPLETION_REPORT.md for what is verified and what is not.

* One permanent QR -> static HTTPS page -> employee enters Employee ID -> server picks the session from its own clock,
  validates the schedule, allocates a room in PostgreSQL, returns the allocation.
* Free-tier only: static hosting + a new Supabase project (PostgreSQL, RPC, Auth). No server, VPS or KVM.

## Run the tests

Requires Docker and Node 22+ (Chrome for the browser tests).

```
npm install && npm run stack:up      # PostgreSQL 17 + PostgREST in Docker (local, throwaway)
npm test && npm run test:api         # 113 database tests, 11 Data API tests
cd web && npm install
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e                          # 42 browser tests
```

## Docs

* [Architecture](docs/ARCHITECTURE.md), [Decisions](docs/ARCHITECTURE_DECISIONS.md)
* [Database schema](docs/DATABASE_SCHEMA.md), [Allocation algorithm and locking](docs/ALLOCATION_ALGORITHM.md)
* [Completion report](docs/COMPLETION_REPORT.md), [Deployment](docs/DEPLOYMENT.md), [Exam-day runbook](docs/EXAM_DAY_RUNBOOK.md), [Testing](docs/TESTING.md), [Performance](docs/PERFORMANCE.md)
* [Admin configuration](docs/ADMIN_CONFIGURATION.md), [Schedule import](docs/SCHEDULE_IMPORT.md)
* [Security model](docs/SECURITY_MODEL.md)
* [Supabase setup and migration deployment](docs/SETUP_SUPABASE.md)
* [Load-test plan and results](docs/LOAD_TEST_PLAN.md)

## Layout

```
supabase/migrations/   0001-0010: schema, allocation engine, security, admin RPCs, import, branding, reports (apply in order)
web/                   React frontend (src, unit tests, Playwright e2e)
tests/db, tests/api    PostgreSQL suites and Data API (PostgREST) suites
tools/                 local test stack, load script
scripts/               admin bootstrap SQL, QR generator
loadtest/              k6 script, seed and verification SQL (not yet run on Supabase)
docs/
```

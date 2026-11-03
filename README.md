# EOMS Lite

Lightweight, QR-based invigilator room allocation. Independent of the production EOMS.

**Status: Phase 1 (database + allocation engine).** No frontend yet.

* One permanent QR -> static HTTPS page -> employee enters Employee ID -> server picks the session from its own clock,
  validates the schedule, allocates a room in PostgreSQL, returns the allocation.
* Free-tier only: static hosting + a new Supabase project (PostgreSQL, RPC, Auth). No server, VPS or KVM.

## Run the tests

Requires Docker and Node 22+.

```
npm install
npm run db:up
npm test
```

## Docs

* [Architecture](docs/ARCHITECTURE.md), [Decisions](docs/ARCHITECTURE_DECISIONS.md)
* [Database schema](docs/DATABASE_SCHEMA.md), [Allocation algorithm and locking](docs/ALLOCATION_ALGORITHM.md)
* [Security model](docs/SECURITY_MODEL.md)
* [Supabase setup and migration deployment](docs/SETUP_SUPABASE.md)
* [Load-test plan and results](docs/LOAD_TEST_PLAN.md)

## Layout

```
supabase/migrations/   0001 schema, 0002 functions, 0003 security (apply in order)
tests/db/              node:test suites against real PostgreSQL (+ test-only Supabase shim)
loadtest/              k6 script, seed and verification SQL (not yet run on Supabase)
docs/
```

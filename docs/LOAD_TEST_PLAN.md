# Load-test plan and results

## Status

| Item | Status |
|---|---|
| Local concurrency correctness tests on PostgreSQL 17 (Docker) | **Done, measured** (below) |
| k6 script, seed and verification SQL | Written. Seed + verify SQL executed once locally (300 concurrent check-ins, zero violations). **k6 itself has not been run.** |
| Any test against a real Supabase project (PostgREST + pooler + free tier) | **Not done. No Supabase numbers exist.** |

## Targets (not results)

| Metric | Target |
|---|---|
| Rehearsal | 500 requests over 15-20 min, each either correctly allocated or correctly rejected |
| Burst | 100 simultaneous; 200 simultaneous |
| Latency | p95 < 1 s under the normal workload (client-measured, incl. network/TLS) |
| Duplicate active allocations | 0 |
| Capacity violations | 0 |
| Unexplained server errors | 0 (`BUSY`, `RATE_LIMITED`, HTTP 5xx/429 all count as "to investigate") |

## Measured so far (local Docker, this machine; NOT representative of Supabase)

From `tests/db/concurrency.test.js`, run on the author's Windows machine against `postgres:17` in Docker with a
100-connection pool and warm connections:

* 200 concurrent check-ins, 30 rooms (141 slots): 141 `ALLOCATED`, 59 `ROOMS_FULL`, 0 `BUSY`.
  Latency over two runs: p50 566-663 ms, p95 697-860 ms, p99 704-877 ms, max 707-881 ms, wall time 0.9-1.1 s.
* 0 duplicate active allocations, 0 capacity violations, 0 policy-order violations (replay check) in every
  concurrency test; the same tests fail 6 of 6 when the advisory lock is disabled (checked once, then restored).

Interpretation, carefully: these latencies are queueing time inside one serialised session: 200 requests were issued
at the same instant and the last waited behind the others (~4-5 ms of database work each). They show the lock does
not deadlock or time out at that burst size on a local database. They say **nothing** about Supabase free-tier
latency, connection limits, API gateway limits or cold behaviour.

## Plan for the real rehearsal (needs a staging Supabase project)

1. Create a **throwaway** Supabase project, apply migrations, run `loadtest/seed_loadtest.sql` (600 employees, 700 slots).
2. `k6 run -e SUPABASE_URL=... -e ANON_KEY=... -e SCENARIO=<name> loadtest/k6-checkin.js` for each scenario:
   `burst100`, `burst200`, `dupes`, `sustained`. Reset the database between scenarios (recreate the project or run
   a cleanup script as owner; audit/allocations are append-only to API roles by design).
3. After each: run `loadtest/verify_correctness.sql`; every query must return 0 rows.
4. Record, per scenario: request count, result-code histogram, p50/p95/p99/max, HTTP error and 429 counts, `BUSY` count.
5. Extra cases: exhausted capacity (lower capacities); allocation concurrent with an admin correction;
   a full-capacity rollback (kill a request mid-flight); first request after the project has been idle.
6. Observe in the Supabase dashboard: active connections, pooler saturation, CPU, any paused/limited banner.
7. Report measured results separately from the targets above. If a target is missed, name the bottleneck.

## Things the free tier might break (all unverified, check current vendor docs first)

* Project auto-pause after inactivity (first request after a long idle may fail or be slow).
* API/pooler connection limits and per-request statement timeout vs. the 2 s `lock_timeout`.
* Egress/request quotas, and whether a burst from one campus IP is rate-limited by the platform.
* Shared compute: CPU credit exhaustion during a burst.

If any of these prevents the targets, the options are: keep-alive + pre-exam warm-up, a short paid tier only for the
exam window (a business decision, not made silently), or moving the RPC behind a different free host. None is
assumed to be needed until measured.

## Reproduce the local numbers

```
npm run db:up
npm test
```

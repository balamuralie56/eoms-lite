# Performance: measured, estimated, not tested

Workload to support: about **500 check-ins within 15-20 minutes**, with possible bursts of **100-200 simultaneous requests**.

## 1. Measured (local only: Docker PostgreSQL 17 + PostgREST 12.2.3 on one Windows machine)

**These are NOT Supabase numbers.** They show the design works on a quiet local database; they say nothing about Supabase's shared
CPU, network latency to a region, or its gateway. Run date 2026-11-04. Raw output: `results/http-load.json` (git-ignored; regenerate with
`node tools/load/http-load.mjs`).

HTTP through PostgREST (browser-shaped requests, anon key as Bearer token, connections already warm):

| Scenario | n | p50 | p95 | p99 | max | Result |
|---|---:|---:|---:|---:|---:|---|
| A. 100 simultaneous distinct employees | 100 | 294 ms | 388 ms | 394 ms | 394 ms | 100 allocated, 0 errors |
| B. 200 simultaneous distinct employees | 200 | 549 ms | 869 ms | 895 ms | 910 ms | 200 allocated, 0 errors |
| C. 200 simultaneous, one employee repeated | 200 | 375 ms | 610 ms | 621 ms | 625 ms | 1 allocated + 199 `ALREADY_ALLOCATED` |
| D. 250 simultaneous into 150 slots | 250 | 535 ms | 779 ms | 787 ms | 793 ms | 150 allocated + 100 `ROOMS_FULL` |
| E. 500 paced over 60 s (8.3 req/s) | 500 | 14 ms | 21 ms | 27 ms | 38 ms | 500 allocated, 0 errors |

In every scenario: **0 duplicate active allocations, 0 over-capacity rooms, 0 HTTP errors, 0 `BUSY`, 0 `RATE_LIMITED`.**
The high percentiles in A-D are queueing: requests issued at the same instant wait behind each other for the per-session lock
(≈3-4 ms of database work each), which is the price of the guarantee. Scenario E is the realistic arrival pattern and is ~15 ms.

Other local measurements: 5000-row schedule import staged + validated in ≈0.3-1.1 s, committed in ≈0.35 s (10 chunk requests of 500 rows);
`admin_overview`/lists are small indexed queries (not separately timed).

## 2. Verified facts about the free tiers (supabase.com pricing page and docs, fetched 2026-11-04)

| Fact | Source | Implication |
|---|---|---|
| Free: 500 MB database, 5 GB egress, 50,000 MAU, "unlimited" API requests, 2 active projects, shared CPU 500 MB RAM | supabase.com/pricing | Capacity is not the concern at ~500 check-ins per session. |
| Free projects **pause after 1 week of inactivity**; restorable from the dashboard | pricing + docs "going into prod" | Operational risk: see runbook (Active the day before). |
| **No automatic backups** on Free | pricing | Export after each session. |
| Default statement timeouts: **anon 3 s, authenticated 8 s** | supabase.com/docs/guides/database/postgres/timeouts | `checkin` caps lock-waiting at 2 s (< 3 s) so it answers `BUSY` instead of being killed. Import commit (< 8 s) is 0.35 s locally. |
| Free-plan **connection/pooler limits are not published** on the pricing page | pricing | **Unknown.** Must be measured on the real project. |
| Cloudflare Pages Free: 500 builds/month, 20,000 files and 25 MiB per file (secondary sources; the official page could not be fetched) | web search | A small static site is far inside these. Re-check the official page. |

## 3. Estimated (reasoning, not measurement)

* Total database work for 500 check-ins ≈ 500 × a few ms ≈ a few seconds, so the sustained rate (≈0.5 req/s average over 15-20 min) is trivial.
* In a 200-request burst the last request waits for the others: about 200 × (database time per request). If Supabase's shared CPU makes one request ~3× slower than local, the worst-case wait would be ~2.5 s, which would exceed the 2 s lock timeout for the tail of the burst. Those requests would get `BUSY` and the page retries automatically (up to 5 attempts with exponential backoff and jitter), so employees see a short delay, not a failure. **This is an estimate to be confirmed.**
* Network latency from a phone to the Supabase region adds on top (typically tens to a few hundred ms).

## 4. Not tested

* Anything on a real Supabase project (latency, connection limits, pooler behaviour, cold start after a pause, the first request after idle).
* Real phones on a real network; real Cloudflare edge.
* Browser performance on low-end phones (the slip canvas render is ~1800×1100; not benchmarked).
* A real 15-20 minute rehearsal.

## 5. Plan for the real rehearsal (needs a staging Supabase project)

1. Apply migrations 0001-0010 to a **throwaway** project; run the smoke test (`SETUP_SUPABASE.md`).
2. `loadtest/seed_loadtest.sql` then `loadtest/k6-checkin.js` scenarios `burst100`, `burst200`, `dupes`, `sustained` (k6 not run yet), and the same five scenarios of `tools/load/http-load.mjs` adapted to the project URL.
3. After each run execute `loadtest/verify_correctness.sql` (all queries must return 0 rows).
4. Record p50/p95/p99, error and `BUSY` rates, and watch the dashboard for connection saturation.
5. Repeat after the project has been idle for a few days to see the resume behaviour.

**Acceptance targets** (unchanged): p95 < 1 s under the normal workload; zero duplicates; zero capacity violations; zero unexplained errors.
If a target is missed, the options are a short paid tier for the exam window, a keep-alive/warm-up, or a smaller burst per queue. None is assumed necessary until measured.

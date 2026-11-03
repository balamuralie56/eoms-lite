# EOMS Lite architecture

EOMS Lite is a small, standalone system for QR-based invigilator room allocation. It is **independent of the
production EOMS**: separate repository, separate database, no shared credentials, domain or deployment.
Only business concepts were reused (zero-first allocation, idempotent re-submit, audit trail).

## Flow

```
Permanent QR  ->  https://<stable domain>/        (static page, any phone camera)
   Employee types Employee ID
   -> POST /rest/v1/rpc/checkin {p_employee_id}   (Supabase Data API, anon key)
        -> public.checkin():  normalise ID -> throttle -> resolve session from SERVER time
           -> verify schedule (exact date + session) -> take per-session advisory lock
           -> idempotency / flags / released / window checks -> allocate by policy -> audit
   <- JSON result code (+ minimal allocation data)  ->  page renders slip, client-side PNG
Admin (named Supabase Auth account) -> admin_* RPCs / RLS-filtered reads
```

## Components (free-tier only)

| Layer | Choice | Phase |
|---|---|---|
| Static frontend | React + TypeScript + Vite on Cloudflare Pages (or similar) | Phase 2 |
| Database + API | New Supabase project: PostgreSQL, PostgREST RPC, Supabase Auth for admins | **Phase 1 (this repo)** |
| Business rules | SQL functions, constraints, triggers, RLS | **Phase 1** |
| Spreadsheet parsing | In the browser (CSV/XLSX), validated again in the database before commit | Phase 2 |
| Slip | Canvas -> PNG, client-side | Phase 2 |
| Backend server | **None.** No FastAPI, VPS, KVM | n/a |

No secret reaches the browser. The browser holds only the public project URL and anon key. The `service_role` key is
never used client-side.

## Phase 1 scope delivered

Schema, constraints, integrity triggers, RLS/grants, `get_checkin_status`, `checkin`, admin late/re-entry
authorization, correction/release, flag workflow, audit, and 47 database tests on real PostgreSQL.

## Not in Phase 1

Frontend, PNG slip, schedule import RPC and parser, admin UI, audited RPCs for editing sessions/rooms/capacities,
CSV/XLSX exports, monitoring views, abuse-table cleanup job, any measurement on real Supabase.
In Phase 1, sessions/rooms/schedule are created by SQL as the project owner (tests do exactly this).

## Time

Sessions are configured in `Asia/Kolkata` by the admin UI and stored as `timestamptz` instants. All decisions use the
database clock (`now()`); the client clock and time zone are never trusted. `exam_date` is a plain date and must be
set consistently by the admin UI (it is what the schedule is matched against).

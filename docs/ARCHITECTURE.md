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

## Phase 2A scope delivered (database-side administration)

Audited admin RPCs for sessions, rooms, per-session room eligibility and invigilator capacity
(`ADMIN_CONFIGURATION.md`), and a two-stage staged schedule import with a dry run, in-database revalidation,
transactional commit and an explicit, separately confirmed replace action (`SCHEDULE_IMPORT.md`).
Guard triggers make the invariants hold even for direct SQL. 96 database tests (Phase 1 + 2A) on real PostgreSQL.

```
Admin browser (Phase 2B)                          Supabase (PostgreSQL)
  parse CSV/XLSX ──chunks of <=500 rows──►  admin_import_begin / add_rows ─► import_rows (staging)
  preview  ◄────── rows, statuses, msgs ───  admin_import_validate / preview   (schedule untouched)
  confirm  ───────────────────────────────►  admin_import_commit ─► [lock] revalidate ─► schedule (atomic)
  configure sessions/rooms/capacity ──────►  admin_* RPCs ─► [session lock] ─► audit_log
```

## Not yet built

Frontend (public page, PNG slip, admin UI), CSV/XLSX exports, monitoring views, removal/undo of imported schedule rows,
abuse-table cleanup job, any measurement or smoke test on real Supabase.
Sessions/rooms/schedule can now be managed through RPCs; direct SQL by the project owner remains possible but is not audited.

## Time

Sessions are configured in `Asia/Kolkata` by the admin UI and stored as `timestamptz` instants. All decisions use the
database clock (`now()`); the client clock and time zone are never trusted. `exam_date` is a plain date and must be
set consistently by the admin UI (it is what the schedule is matched against).

# Architecture decisions

Each entry: decision, why, trade-off. "Assumption" marks things not yet verified.

## ADR-1 Independent project
Own repo/folder (`eoms-lite`, sibling of the old project, no shared remote), own Supabase project. The old EOMS is untouched.

## ADR-2 Rules live in PostgreSQL
Allocation, idempotency, capacity and audit are SQL. Clients cannot bypass them and there is no server to run.
*Trade-off:* business logic is in SQL; tests must run against real PostgreSQL (they do).

## ADR-3 One advisory lock per session, not row locks / SKIP LOCKED
See `ALLOCATION_ALGORITHM.md`. Row-level `SKIP LOCKED` can show a request a partial room list (false "full",
non-minimum choice). A per-session transaction-level advisory lock under READ COMMITTED gives exact counts.
*Trade-off:* a session's allocations are serialised. At ~4-5 ms of work per request locally this is fine; **to be
confirmed on Supabase**. Waiting is bounded by `lock_timeout` (`BUSY`, retryable).

## ADR-4 Unique partial index + trigger as the last line of defence
The lock is the primary mechanism; the partial unique index and the capacity trigger guarantee integrity even if a
future function forgets the lock or someone inserts directly.

## ADR-5 Domain results as JSON, not exceptions, for public RPC
Rejections (`NOT_SCHEDULED`, `ROOMS_FULL`, ...) are HTTP 200 with `ok:false` and a stable `code`. An exception would
roll back the whole transaction, including the throttle record. Admin RPCs raise on misuse (nothing to preserve).

## ADR-6 Single generic `NO_ACTIVE_SESSION`
Outside the window every employee gets the same code. A distinct "your session closed" code would reveal which IDs
are scheduled. Late entry therefore goes through an admin permit; no automatic grace.

## ADR-7 Admin permits instead of an "admin allocates" shortcut
Late and re-entry use one-shot permits that the employee then redeems via the normal flow. The permit waives the
window only; schedule, flags, room activity and capacity are still enforced by the same code path.
*Trade-off:* two steps (admin authorizes, employee submits). Benefit: one allocation code path, one set of rules.

## ADR-8 Overlap prevention by exclusion constraint
`EXCLUDE USING gist (tstzrange(opens, closes,'[)') WITH &&) WHERE (is_active)`. It makes "at most one open session"
a database fact, so the `limit 1` in session resolution is safe and there is nothing to guess.

## ADR-9 RLS default-deny, admin read via policy, all writes via functions
Admins get SELECT through `is_admin()` policies for the future dashboard; nobody gets table writes. Every change is
therefore audited by construction. *Trade-off:* each admin operation needs an RPC (Phase 2 adds config/import RPCs).

## ADR-10 Employee ID is not authentication
Documented in `SECURITY_MODEL.md`. We minimise exposure and throttle; we do not claim identity is proven.
*Assumption (unverified):* `request.headers` carries a usable client IP on Supabase.

## ADR-11 Tests use a shim for Supabase's `auth` schema and roles
`tests/db/00_supabase_shim.sql` provides `anon`/`authenticated`/`service_role` and `auth.uid()` so the **unmodified**
migrations run on a plain PostgreSQL 17 container. *Gap:* PostgREST, Supabase Auth and the pooler are not exercised.
A smoke test on a real project is required (see `SETUP_SUPABASE.md`).

## ADR-12 Audit every allocation
One extra INSERT per successful check-in (about 500 per session) is cheap and gives a full trail.
Failed lookups are *not* audited (only throttle-counted) to avoid write amplification under abuse.

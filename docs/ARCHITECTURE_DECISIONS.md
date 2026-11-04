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

## ADR-13 Phase 2A is additive: new migrations 0004-0007, Phase 1 migrations untouched
Phase 1 files are byte-identical to the Phase 1 commit. New behaviour (guard triggers, admin RPCs, import tables) arrives
as new versioned migrations, so a project that already applied 0001-0003 only needs 0004-0007.

## ADR-14 Configuration shares the allocation lock
Every admin RPC that can change what the engine sees (session window/active, room active, session-room capacity/active,
room details) takes `eoms_private.lock_session` (rooms: every session they are in, in id order, so admins cannot deadlock).
Deterministic tests hold the lock in another transaction and prove each RPC waits.
*Trade-off:* an admin edit waits behind in-flight check-ins (milliseconds) and vice versa.

## ADR-15 Guard triggers as a second line of defence
`session_rooms` (capacity cannot drop below active allocations; link immutable) and `exam_sessions` (date/label frozen
after allocations) have triggers, so the rules hold even if someone edits tables directly or a future RPC forgets them.

## ADR-16 Times in, as local IST text; offsets rejected
`2026-11-03 08:30`, converted with `AT TIME ZONE 'Asia/Kolkata'`. A UTC offset in the text is refused because a
`timestamp` cast would silently drop it, shifting an exam window by hours.

## ADR-17 Import is staged in tables, not one big RPC
Bounded chunks (500 rows) into `import_rows`; validation and commit run in SQL over the staged rows. Avoids oversized
request bodies and long transactions; staging is retryable and previewable. The file-size limit is advisory (the file
never reaches the database); row, chunk and field-length limits are the enforced bounds.

## ADR-18 Non-destructive import; replacement is a separate action
Default commit only inserts. Exact duplicates are skipped; conflicts require an explicit `skip`/`abort` decision; any
invalid row blocks the commit. Overwriting is a distinct, confirmed RPC with per-row before/after audit.

## ADR-19 Commit revalidates and is serialised
`admin_import_commit` takes a global import advisory lock and revalidates inside the transaction; if counts changed since
the preview it refuses (`CHANGED_SINCE_PREVIEW`). The insert is in a sub-transaction so a failure leaves no partial rows
yet still records the failure. Business rejections are JSON results (so state and audit persist), misuse raises.

## ADR-20 Set-based SQL, no self-join on function-calling subqueries
A first version of validation took ~32 s for 5000 rows because an UPDATE joined to an aggregate over the same table was
re-evaluated per row. Rewritten as row-wise updates plus a materialised window-function pass joined back by primary key
(~0.3 s). Measured locally; to be re-measured on Supabase.
## ADR-21 Test the browser against the real Data API engine, with an honest stand-in for auth
No Supabase CLI/GoTrue was available. A Docker PostgREST in front of the real migrations exercises the same RPC parameter shapes, status codes, JWT checks and
request headers the app will meet, and revealed behaviour that mocks hide (missing parameter -> 404 `PGRST202`; anon key must be a JWT; expiry leeway). Auth is a
small stand-in and is labelled as such everywhere; Supabase Auth itself remains untested.

## ADR-22 Serve the E2E build with the real `_headers` and `_redirects`
So the CSP and SPA fallback are tested, not assumed. This caught a real CSP violation (QR download via `fetch(data:)`).

## ADR-23 Branding is data, stored in the database
Institution name, cell name, title, contact text and logo live in `app_branding` and reach the public page through one anonymous function, so nothing
institution-specific is hard-coded. Logos are small raster images only (SVG refused).

## ADR-24 No tamper-proof slip claim
A client-rendered PNG is editable. We state that on the slip and in the docs rather than add an unverifiable code. Verification is administrator-assisted.

## ADR-25 XLSX via `read-excel-file`/`write-excel-file`, not `xlsx`
The npm `xlsx` package is unmaintained with known advisories; the chosen libraries are maintained and sufficient (read first sheet, write one sheet).

## ADR-26 Retention is explicit and never touches audit
Throttle rows, abandoned staging and old staged rows are purged on a schedule/by button; audit records are append-only and permanent.

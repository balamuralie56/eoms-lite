# Allocation algorithm and concurrency

Implemented in PostgreSQL (`supabase/migrations/0002_functions.sql`). Nothing about allocation runs in the browser.

## Policy (mandatory invariant)

For a session, with `count(room)` = number of ACTIVE allocations (`released_at is null`) in that session-room:

1. **Eligible** rooms: `session_rooms.is_active` AND `rooms.is_active` AND `count(room) < max_invigilators`.
2. `m = min(count)` over eligible rooms.
3. Pick **uniformly at random** (`order by random() limit 1`) among eligible rooms with `count = m`.
4. Insert the allocation with `round = count + 1`.

Consequences: every eligible room gets its first invigilator before any room gets a second, then a
second before any third, and so on. A room that reaches its own capacity leaves the pool; rooms with
larger capacity simply stay eligible for more rounds. Randomness exists only among equal-minimum rooms.
If no room is eligible the result is `ROOMS_FULL`; nothing is written.

The code is `eoms_private.allocate()`. Student seating capacity (`Room.capacity` in old EOMS) does not exist here.

## Locking strategy

**Mechanism:** `pg_advisory_xact_lock(hashtextextended('eoms:session:' || session_id, 0))`, one lock per exam session.

* Transaction-scoped: released automatically at COMMIT/ROLLBACK, including on crash or error. No lock can leak,
  which matters with a connection pooler in transaction mode (Supabase pooler).
* Taken **before any read that decides the outcome** in: `checkin`, `admin_reassign`, `admin_release`,
  `admin_authorize_*`, `admin_revoke_authorization`, `admin_flag_employee`, `admin_resolve_flag`, and again
  (re-entrantly) inside the `allocations` insert trigger. Employee allocations and admin corrections therefore
  serialise against each other.
* Sessions do not block each other (different keys). A 64-bit hash collision between two sessions would only add
  harmless extra waiting.

**Why this is correct:** the functions run at `READ COMMITTED` (asserted at runtime; `REPEATABLE READ` or
`SERIALIZABLE` raises `25000`). In `READ COMMITTED` every statement takes a fresh snapshot, so after a waiter
acquires the lock its next statement sees everything the previous holder committed. The per-room counts are then
exact, so the selection in steps 1-3 is made against the true state, and the insert in step 4 cannot race.

**Why not `SKIP LOCKED`:** the old EOMS used `FOR UPDATE SKIP LOCKED` on room rows. A request skips rooms locked by
another in-flight request, so under a burst it can see a partial room list: it may report "no rooms" while capacity
remains, or choose a non-minimum room because the true minimum was locked. Both violate the invariant. A single
per-session lock is simpler and provably ordered, at the price of serialising a session's allocations.

**Cost of serialising:** each critical section is a few indexed statements. The measured local figures are in
`LOAD_TEST_PLAN.md`; whether the same holds on Supabase's free tier is **not yet measured**.

**Bounded waiting:** `checkin` sets `lock_timeout = '2s'`. A waiter that cannot get the lock returns the retryable
result `BUSY` (HTTP 200 JSON, nothing written) instead of hanging. Admin functions use `5s` and raise.

## Uniqueness and integrity backstops

| Guarantee | Enforced by |
|---|---|
| One active allocation per employee per session | `allocations_one_active_per_employee` partial unique index `(session_id, employee_id) where released_at is null` |
| No over-capacity | RPC check under the lock **and** `allocations_guard_insert` trigger (takes the same lock, counts, raises `23514`) so even a direct insert cannot exceed capacity |
| No allocation into inactive room/session | same trigger |
| Room belongs to the allocation's session | composite FK `(session_room_id, session_id) -> session_rooms(id, session_id)` |
| Allocations never edited/deleted | `allocations_guard_update` (only one-way release), `allocations_no_delete`/`no_truncate` |
| No overlapping active check-in windows | `exam_sessions_no_overlap` GiST exclusion constraint on `tstzrange(opens, closes, '[)')` where active |
| Audit is append-only | triggers raising on UPDATE/DELETE/TRUNCATE + no privileges for API roles |

## Idempotency and re-submission

Inside the lock, step 1 looks for an active allocation for `(session, employee)`. If present it is returned as
`ALREADY_ALLOCATED` with identical room, reference and timestamp. The room is never re-chosen. After an admin
correction the corrected (active) allocation is what is returned.

A **released** allocation is never recreated by the employee: they get `REENTRY_REQUIRES_ADMIN` until an admin
calls `admin_authorize_reentry`.

## Session resolution

`checkin` resolves the session from server time only:

1. An unconsumed, unrevoked, unexpired admin permit for this employee (whose session has no active allocation for
   them) selects that permit's session.
2. Otherwise the single active session with `opens <= now() < closes`.
3. Otherwise `NO_ACTIVE_SESSION`. There is **no fallback** to the most recent or next session.

`now()` is the transaction start time, fixed for the whole call: a request that starts inside the window is judged
by that instant even if it waits briefly for the lock.

## Decision order inside `checkin`

format check -> abuse throttle -> resolve session -> schedule check (exact date + session) -> **lock** ->
existing active allocation -> flag (pending/blocked) -> released-without-re-entry -> window (unless permit) ->
allocate -> consume permit -> audit.

Late/re-entry permits waive only the **window** (and, for re-entry, the "released" block). Schedule validation,
flags, room activity and capacity always apply; a failed allocation does not consume the permit.

## Admin correction

`admin_reassign(allocation_id, new_session_room_id, reason)`: under the session lock, verifies the target belongs
to the same session, is active, and has space, releases the old row (`released_by`, `release_reason`) and inserts a
new row (`source='admin_correction'`, `supersedes_allocation_id`). Admin placement deliberately bypasses the
minimum-count rule (it is a human decision) but never capacity or activity rules.

# Admin configuration (Phase 2A)

Source: `0005_admin_config_functions.sql` plus the guard triggers in `0004_admin_schema.sql`.
All functions: authenticated **active** admin required (identity from `auth.uid()`), audited with before/after JSON and
a request reference, `SECURITY DEFINER`, `search_path = ''`. Anything that can change what the allocation engine sees
takes the **same per-session advisory lock** as employee allocation (`eoms_private.lock_session`).

Rejections of invalid use raise an error (SQLSTATE in the table); nothing is written.

## Time zone

Times are passed as **local Asia/Kolkata wall-clock text**: `2026-11-03 08:30` (or `T`, optional seconds). An explicit UTC
offset (`Z`, `+05:30`) is **rejected on purpose**, because casting such text to `timestamp` would silently discard
it. Values are converted to `timestamptz` (`08:30 IST` = `03:00 UTC`). Responses return `..._ist` strings.

## Sessions

| RPC | Does | Rules |
|---|---|---|
| `admin_create_session(date, label, opens_local, closes_local, is_active=true)` | create | label `FN/AN/Forenoon/Afternoon`; closes > opens; window <= 24 h; window must include the exam date (IST); overlap with another **active** window -> `23P01`; same date+label -> `23505` |
| `admin_update_session(id, date?, label?, opens_local?, closes_local?)` | edit (NULL = unchanged) | takes the session lock; same window rules; **date/label are frozen** (`23514`) once the session has any allocation (including released) or the schedule references its date+label |
| `admin_set_session_active(id, active, reason, confirm=false)` | (de)activate | takes the lock; deactivating with active allocations needs `confirm = true` (`22023`); re-activating into an overlap -> `23P01`; no-op returns `unchanged` |

Window changes are allowed while allocations exist (audited). There is no session delete: deactivate instead.
Database backstop: an `exam_sessions` trigger refuses a date/label change when allocations exist.

## Rooms (physical; no seating capacity anywhere)

| RPC | Does | Rules |
|---|---|---|
| `admin_create_room(code, building?, floor?)` | create | code trimmed and **upper-cased**, so duplicates are case-insensitive (`23505`); max 50 / 100 chars |
| `admin_update_room(id, code?, building?, floor?, confirm=false)` | edit (NULL = unchanged, `''` clears building/floor) | locks every session the room is in; if the room has active allocations, changing code/building/floor needs `confirm = true` because issued slips show them |
| `admin_set_room_active(id, active, reason, confirm=false)` | (de)activate globally | locks all sessions of the room; deactivating a room with active allocations needs `confirm`; **existing allocations stay**, only new ones stop |

Rooms are never deleted by any RPC; the database refuses to delete a room or session-room that has allocations (FK).

## Per-session rooms and invigilator capacity

| RPC | Does | Rules |
|---|---|---|
| `admin_assign_room_to_session(session, room, max_invigilators)` | make a room eligible for a session | capacity 1..100; duplicate link -> `23505` |
| `admin_update_session_room(session_room, max_invigilators)` | change capacity | takes the lock; **cannot go below the active allocation count** (`23514`); the database enforces the same via a trigger even for direct SQL |
| `admin_set_session_room_active(session_room, active, reason, confirm=false)` | session-specific eligibility | deactivating with active allocations needs `confirm`; inactive links never receive allocations |
| `admin_remove_session_room(session_room, reason)` | remove an unused link | only if the link has **no allocation history** (released rows count); otherwise deactivate |

The same room can have different capacities in different sessions (capacity lives on `session_rooms`).

## Allocation corrections, releases, authorizations, flags (Phase 1, unchanged)

`admin_release`, `admin_reassign`, `admin_authorize_late`, `admin_authorize_reentry`, `admin_revoke_authorization`,
`admin_flag_employee`, `admin_resolve_flag` are reused as they are. See `DATABASE_SCHEMA.md`.

## What an admin cannot do (by design)

Edit or delete audit history; write any table directly; delete rooms or sessions; reduce capacity below existing
allocations; change a session's date/label after allocations exist; change what slips show without confirming.

## Not yet available in 2A

Editing the schedule row-by-row, deleting schedule rows or undoing an import, bulk room import, and read-only
reporting RPCs (Phase 2B reads tables through the admin RLS policies).

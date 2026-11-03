# Database schema

Source of truth: `supabase/migrations/0001_schema.sql`. Timestamps are `timestamptz`. Employee IDs are stored as
`upper(btrim(id))` and enforced by CHECK constraints.

| Table | Purpose | Key constraints |
|---|---|---|
| `admins` | Authorization list for named admin accounts (`user_id` = Supabase Auth user id) | PK `user_id`; `is_active` |
| `app_settings` | Integer settings (throttle limits) | PK `key` |
| `exam_sessions` | One row per date + FN/AN with check-in window | `unique(exam_date, session_label)`; `closes > opens`; **GiST exclusion: no overlapping windows among active sessions** |
| `rooms` | Physical rooms (no seating capacity here) | `unique(room_code)` |
| `session_rooms` | Room used in a session + **invigilator** capacity + active flag | `unique(session_id, room_id)`; `unique(id, session_id)`; `max_invigilators >= 1` |
| `import_batches` | Spreadsheet import log (used from Phase 2) | status check |
| `schedule` | Uploaded duty roster | PK `(employee_id, exam_date, session_label)`; normalised id check |
| `allocations` | Employee -> session-room, history kept | partial unique `(session_id, employee_id) where released_at is null`; composite FK to `session_rooms(id, session_id)`; triggers (capacity, activity, immutability); `seq` gives insertion order |
| `admin_authorizations` | One-shot permits: `late` (waive window) / `reentry` (after release) | partial unique one open permit per `(session, employee)`; reason required |
| `employee_flags` | Verification exceptions raised and resolved by admins | partial unique one pending per `(session, employee)` |
| `check_attempts` | Failed-lookup log for throttling (IP hash only) | index `(ip_hash, at desc)` |
| `audit_log` | Append-only audit trail | immutable triggers |

Minimal employee data: only `employee_id`, `employee_name`, `department` live in `schedule`. No phone/email.

## `allocations` columns

`id`, `seq`, `session_id`, `session_room_id`, `employee_id`, `round`, `allocated_at`,
`source` (`normal` | `admin_late` | `admin_reentry` | `admin_correction`), `released_at`, `released_by`,
`release_reason`, `supersedes_allocation_id`, `created_by` (admin uuid for admin sources).
A release requires a reason (CHECK). Rows are never deleted or un-released.

## Flagged-case workflow (defined for this phase)

1. An admin calls `admin_flag_employee(employee, session, reason)` -> `employee_flags.status = 'pending'`.
2. The employee's `checkin` returns `VERIFICATION_REQUIRED` plus a short reference. Nothing is allocated.
3. Only an admin can resolve: `admin_resolve_flag(flag, 'cleared' | 'blocked', note)`.
   `cleared` -> the next submission proceeds through the normal rules. `blocked` -> stays `VERIFICATION_REQUIRED`.
   A blocked flag can later be cleared by an admin. Employees cannot resolve their own flag.
4. Every step is audited. **No automatic flagging exists yet** (open decision).

## Late check-in and re-entry

* Normal check-in outside the window -> `NO_ACTIVE_SESSION` (one generic code so nothing reveals that an ID is scheduled).
* `admin_authorize_late(employee, session, reason, expires_at?)` requires the employee to be on the schedule for that
  session, no active allocation, and no earlier released allocation. It stores admin id, timestamp and reason and
  writes an audit row. The employee then submits normally; the permit waives only the window and is consumed on success.
* `admin_authorize_reentry` is the equivalent for an employee whose allocation was released.
* Permits can be revoked (`admin_revoke_authorization`) and may carry an admin-set expiry. No automatic grace periods.

## Migrations

`0001_schema.sql` tables/constraints/triggers -> `0002_functions.sql` allocation engine and RPCs -> `0003_security.sql`
RLS and grants. Apply in order. `tests/db/00_supabase_shim.sql` is test-only and must never be deployed.

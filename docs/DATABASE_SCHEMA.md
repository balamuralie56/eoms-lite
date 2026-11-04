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

## Phase 2A additions (migrations 0004-0007)

* `import_batches` gained: `declared_rows`, `declared_file_bytes`, `valid_count`, `invalid_count`,
  `duplicate_in_batch_count`, `exact_duplicate_count`, `conflict_count`, `inserted_count`, `replaced_count`,
  `validated_at`, `committed_at`, `committed_by`, `error`. Status is now
  `staging | validated | committed | cancelled` (`failed`, `pending`, `rejected` remain allowed but are unused). Default `staging`.
* New table **`import_rows`** (staging): `(batch_id, row_number)` PK; raw values as received, normalised
  `employee_id/employee_name/department/exam_date/session_label`, `status`
  (`pending|valid|invalid|duplicate_in_batch|exact_duplicate|conflict`), `errors text[]`, `existing jsonb` (conflicting live
  values), `outcome` (`inserted|skipped_*|replaced`). Admin read-only via RLS; no other privileges.
* `app_settings`: `import_max_file_bytes` (5 242 880, advisory), `import_max_rows` (5000), `import_chunk_max_rows` (500).
* Guard triggers: `exam_sessions_guard_update` (date/label frozen once allocations exist),
  `session_rooms_guard_update` (capacity cannot drop below active allocations; `session_id`/`room_id` immutable).
* Helpers in `eoms_private`: `parse_date`, `norm_session`, `parse_ist`, `ist_text`, `import_validate`, `validate_window`,
  `lock_room_sessions`, `lock_imports`, JSON builders. None is executable by API roles.

Room codes written through `admin_create_room` / `admin_update_room` are stored upper-case; Phase 1 SQL inserts are unchanged.

## Migrations

| File | Contents |
|---|---|
| `0001_schema.sql` | Phase 1 tables, constraints, integrity triggers |
| `0002_functions.sql` | Phase 1 allocation engine, `checkin`, `get_checkin_status`, admin late/re-entry/release/reassign/flag |
| `0003_security.sql` | Phase 1 RLS, privileges |
| `0004_admin_schema.sql` | Phase 2A import tables/columns, settings, guard triggers, helpers, `import_validate` |
| `0005_admin_config_functions.sql` | session / room / session-room admin RPCs |
| `0006_import_functions.sql` | import RPCs (begin, add_rows, validate, preview, cancel, commit, replace_conflicts) |
| `0007_admin_security.sql` | RLS and grants for the Phase 2A objects |

Apply in order. Phase 1 files are unchanged by Phase 2A. `tests/db/00_supabase_shim.sql` is test-only and must never be deployed.

## Product phase additions (migrations 0008-0010)

* `app_branding` (single row): institution name, exam-cell name, app title, `logo_data_url` (PNG/JPEG/WebP data URL, constrained), contact instructions,
  support info, `default_items_per_page`. Public read only through `get_public_config()`; admin write only through `admin_update_settings()` (audited).
* `app_settings`: `retention_attempts_hours` (48), `retention_staging_days` (7), `retention_committed_rows_days` (90).
* `eoms_private.client_ip_hash()` now ignores the left-most `X-Forwarded-For` entry (see SECURITY_MODEL).
* Read RPCs (all `STABLE`, admin-only): `admin_overview`, `admin_room_monitor`, `admin_list_sessions`, `admin_list_rooms`, `admin_list_schedule`,
  `admin_list_allocations`, `admin_allocation_history`, `admin_list_flags`, `admin_list_authorizations`, `admin_list_audit`, `admin_list_imports`,
  `admin_report` (9 reports: session-, room-, employee-wise allocations, unallocated, full rooms, late check-ins, verification exceptions, corrections/releases, imports).
* Maintenance: `eoms_private.run_maintenance()` (owner / pg_cron), `admin_run_maintenance()`; diagnostic `admin_debug_request_headers()` (never echoes credentials).
* Migration files 0008 settings/maintenance, 0009 read functions, 0010 grants/RLS for them.

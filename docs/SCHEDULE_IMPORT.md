# Schedule import (Phase 2A)

Source: `supabase/migrations/0004_admin_schema.sql` (tables, validation), `0006_import_functions.sql` (RPCs).
The browser parses CSV/XLSX (Phase 2B). The database **re-validates everything**; it never trusts the browser.

## Required columns (nothing else is imported)

`Employee ID`, `Name`, `Department`, `Examination Date`, `Session`.

## Why staging tables (not one big RPC)

A single RPC carrying thousands of rows would be an oversized request body (platform limits unverified) and one
long transaction. Instead:

1. `admin_import_begin` creates a batch (`import_batches`, status `staging`).
2. `admin_import_add_rows` uploads rows to `import_rows` in **chunks** (default max 500 rows per call). Idempotent per
   row number, so a retried chunk is safe. Each call is small and short.
3. `admin_import_validate` validates the whole batch in SQL (read-only with respect to the live schedule).
4. `admin_import_preview` pages through rows with row numbers, statuses and messages.
5. `admin_import_commit` (explicit confirmation) revalidates and copies valid rows into `schedule` in one transaction.

Measured locally (Docker PostgreSQL 17, not Supabase): 5000 rows staged and validated in ~0.4 s over 10 RPC calls,
committed in ~0.35 s. **No Supabase timing exists yet.**

## Limits (in `app_settings`, enforced in the database)

| Key | Default | Enforcement |
|---|---|---|
| `import_max_rows` | 5000 | hard: at `begin` (declared rows) and on every `add_rows` / `commit` (actual staged rows) |
| `import_chunk_max_rows` | 500 | hard: per `add_rows` call |
| `import_max_file_bytes` | 5 242 880 | **advisory**: the file never reaches the database, only parsed rows do. The size declared by the browser is checked, but a client can lie, so the real server-side bounds are the row limit, the 300-character per-field limit and the chunk limit |

Per-field limit: every raw value is rejected above 300 characters. Name max 200, department max 100, ID max 50
(after normalisation).

## Normalisation and validation (inside `eoms_private.import_validate`)

| Field | Rule |
|---|---|
| Employee ID | `upper(btrim)`; must match `^[A-Z0-9._/-]{1,50}$` (the same rule `checkin` applies, so an imported ID is always reachable) |
| Name / Department | whitespace trimmed and collapsed; required; max 200 / 100 |
| Examination Date | `YYYY-MM-DD`, or day-first `D-M-YYYY`, `D/M/YYYY`, `D.M.YYYY`; an optional time part (`2026-11-03 00:00:00`, `...T00:00:00`) is ignored. Impossible dates (31-02) and years outside 2020-2100 are invalid. **Two-digit years and Excel serial numbers are rejected** (the browser must convert Excel date cells to ISO) |
| Session | `FN`, `AN`, `Forenoon`, `Afternoon` (case-insensitive) |
| Session exists | an `exam_sessions` row for that date + label must exist (active or not) |

**Assumption:** slash/dot dates are day-first (Indian convention). `03/11/2026` is 3 November. Confirm with the client.

### Statuses (`import_rows.status`)

| Status | Meaning | Imported on commit? |
|---|---|---|
| `valid` | passes everything, key not yet in the schedule | yes |
| `invalid` | one or more field/session errors, or the same key appears several times in the file with *different* details (all those rows) | **no, and any invalid row blocks the whole commit** |
| `duplicate_in_batch` | same key and same details as an earlier row in the file (first wins) | skipped, reported |
| `exact_duplicate` | already in the live schedule with identical name + department | skipped, reported |
| `conflict` | key already in the live schedule with different name/department; the existing values are returned | skipped (decision required, see below) |

Counts returned: `valid`, `invalid`, `duplicate` (= in-batch + existing exact), `conflict`, with the split available.

## Commit rules (`admin_import_commit(batch, p_confirm, p_on_conflict)`)

* `p_confirm` must be `true`.
* A global advisory lock serialises commits: two simultaneous imports cannot interleave.
* The batch is **revalidated inside the transaction**. If the counts differ from the last preview (e.g. someone
  imported the same rows meanwhile) nothing is imported and `CHANGED_SINCE_PREVIEW` is returned with the new counts;
  commit again after reviewing.
* Any invalid row: `INVALID_ROWS`, nothing imported (no partial imports of a bad file).
* Conflicts need a decision: `p_on_conflict = 'skip'` imports the valid rows and skips conflicts; `'abort'` imports
  nothing (`ABORTED_ON_CONFLICT`); omitting it returns `CONFLICT_DECISION_REQUIRED`.
* Nothing to import: `NOTHING_TO_IMPORT`.
* Insert runs in a sub-transaction: any error rolls back every row of the import, records the error text on the batch
  and an audit row (`import.commit_failed`), returns `COMMIT_FAILED`, and leaves the batch `validated` so it can be retried.
* Success records `status='committed'`, `committed_by`, `committed_at`, `inserted_count`, per-row `outcome`, and an
  audit row. Schedule rows carry `import_batch_id`.

Business rejections return `{ok:false, code, message}` (HTTP 200) so the revalidated counts and audit rows persist;
misuse (no confirmation, unknown batch, not an admin) raises an error.

## Replacing conflicting rows (separate, explicit)

The default import **never overwrites**. After a batch is committed with `skip`, an admin may call
`admin_import_replace_conflicts(batch, p_confirm => true, p_reason)`. It updates only `employee_name` and
`department` of rows that are still in conflict, sets `import_batch_id` to the replacing batch, marks those rows
`replaced`, and writes **one audit row per replaced schedule row** with full before/after values and the reason.
It can be run again safely (rows already identical are skipped).

## Cancelling

`admin_import_cancel(batch, reason)` on an uncommitted batch deletes its staged rows (free-tier storage) and records
the cancellation. Committed batches keep their `import_rows` as a record of what happened.

## Known limitations

* No RPC to **remove** schedule rows or undo a committed import. Corrections to a committed schedule are
  replace-conflicts or SQL by the project owner (unaudited). Planned for a later phase.
* Staged rows of committed batches are not purged automatically.
* Imports do not take the per-session allocation lock: adding schedule rows cannot violate any allocation invariant
  (`checkin` reads the schedule before it locks, and the schedule only grows or has names corrected).
* CSV injection: names beginning with `=`, `+`, `-`, `@` are stored as-is. The export functions (Phase 2B) must neutralise them.

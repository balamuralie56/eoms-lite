# Security model

## Threat summary

| Threat | Control | Residual risk |
|---|---|---|
| Public reads the schedule or other people's allocations | RLS on every table, no `anon` privileges, no policies for `anon` | None known; verified by `security.test.js` |
| Public calls admin operations | `EXECUTE` revoked from `PUBLIC`/`anon`; each admin function re-checks `is_admin()` from `auth.uid()` | Depends on Supabase Auth JWT verification (platform) |
| Client claims to be an admin | No function takes an admin id; identity is `auth.uid()` only | Depends on PostgREST setting JWT claims server-side |
| Privilege escalation via `SECURITY DEFINER` | `search_path = ''`, fully-qualified names, no dynamic SQL, explicit grants | See below |
| Tampering with history | `audit_log` append-only triggers + no API privileges; `allocations` immutable except release | A database superuser can disable triggers (platform owner) |
| **Impersonation: someone enters another employee's ID** | Throttle, audit trail, slip carries reference; **not prevented** | **Open. See below** |
| Brute-force enumeration of IDs | Per-client-IP failure throttle; recommended edge rate limit | Shared NAT can throttle innocent users; spoofable header |
| Over-allocation by race | Advisory lock + trigger + unique index | None known; tested |

## Employee ID is not an authentication secret

The employee enters only an ID. IDs are low-entropy and often known to colleagues. **An ID does not prove identity.**
Anyone who knows an ID can claim that employee's slot (and see that employee's name and department on success).
This is a product decision, not a defect to be hidden. Mitigations implemented or planned:

* Public responses expose the minimum: on success only the caller's own name, department, date, session, room,
  round, time, reference; on failure only a code and message. Not-scheduled returns no data. (Test: `security.test.js`.)
* Every allocation is audited with a reference code; admins can release/correct.
* Failed lookups are throttled per hashed client IP (`check_attempts`, settings in `app_settings`).
* **Not implemented (needs a business decision):** a second factor (e.g. last digits of mobile), CAPTCHA/Turnstile,
  masking the name on the slip. Recommended: an edge rate-limit rule in front of the site in Phase 2.
* `ALREADY_ALLOCATED` also reveals an allocation to whoever knows the ID. Same limitation.

## Roles and privileges

* `anon`: may execute only `public.checkin(text)` and `public.get_checkin_status()`. No table access.
* `authenticated`: `SELECT` on all tables filtered by policy `public.is_admin()` (a signed-in non-admin sees zero rows);
  `EXECUTE` on the admin functions; **no INSERT/UPDATE/DELETE on any table**.
* Mutations happen only inside audited `SECURITY DEFINER` functions.
* `service_role` is never used by the browser. It is only for server-side/CI tasks and is never put in the frontend.
* Nothing is granted by default: `0003_security.sql` revokes everything and sets `ALTER DEFAULT PRIVILEGES` so
  future objects start closed.

## Exact permissions per role (after Phase 2A)

Verified by `security.test.js` and `admin_security.test.js` (catalog and behaviour). "RLS" = filtered by `public.is_admin()`.

| Object | `anon` | `authenticated` non-admin / deactivated admin | `authenticated` active admin | owner / `service_role` |
|---|---|---|---|---|
| `checkin`, `get_checkin_status` (EXECUTE) | yes | yes | yes | yes |
| `is_admin` (EXECUTE) | no | yes (returns false) | yes | yes |
| 24 `admin_*` functions (EXECUTE) | **no** | can execute, **rejected inside** (`not authorized`, 42501) | yes | yes |
| everything in schema `eoms_private` | no | no | no | yes |
| SELECT: `admins`, `app_settings`, `exam_sessions`, `rooms`, `session_rooms`, `schedule`, `allocations`, `admin_authorizations`, `employee_flags`, `check_attempts`, `audit_log`, `import_batches`, `import_rows` | **no (42501)** | grant exists but RLS returns **0 rows** | **yes (RLS)** | yes |
| INSERT / UPDATE / DELETE / TRUNCATE on any table | no | no | **no** (all writes go through the functions) | owner only |
| `audit_log` UPDATE/DELETE/TRUNCATE | no | no | **no** | **blocked by trigger for everyone**; only a superuser disabling the trigger can bypass |

Deactivating an admin (`admins.is_active = false`) takes effect on the next call: the check reads the table on every
call, nothing is cached (tested mid-session).

Admin identity: `eoms_private.require_admin()` returns `auth.uid()` only if that user has an active `admins` row.
**No function has a parameter for an admin id**; audit `actor_user_id`, `created_by`, `released_by`, `authorized_by`,
`committed_by` and `uploaded_by` all come from the JWT (tested: the parameter list of every `admin_*` function is checked).

## `SECURITY DEFINER` functions

Owner: the migration owner (`postgres` on Supabase), which has `BYPASSRLS`; the bodies need to read tables the
caller cannot. **Do not enable `FORCE ROW LEVEL SECURITY`**, it would break them.
Each function: `SET search_path = ''` (verified by a catalog test for every function in `public` and `eoms_private`),
every object schema-qualified, no `EXECUTE`/dynamic SQL, `EXECUTE` revoked from `PUBLIC` then granted explicitly:

| Function | Executable by |
|---|---|
| `checkin`, `get_checkin_status` | `anon`, `authenticated` |
| `is_admin` | `authenticated` |
| `admin_*` (24 functions: 7 Phase 1 + 17 Phase 2A) | `authenticated`, then `require_admin()` inside |
| everything in `eoms_private` | nobody (called only from the above, which run as owner) |

`eoms_private` is not exposed through the Data API (only `public` is). Keep it out of "Exposed schemas".

## Abuse controls (free-tier compatible)

* `check_attempts` stores `sha256(client IP)` and outcome for **failed** lookups only. When failures from one IP
  exceed `throttle_max_failures` in `throttle_window_seconds` (default 60 / 600s), `checkin` returns `RATE_LIMITED`.
* The IP comes from the `request.headers` setting (`cf-connecting-ip`, then first `x-forwarded-for`). **Unverified
  assumption:** that Supabase passes a client-trustworthy value. If the header is absent the throttle is skipped.
  A spoofable header weakens the throttle but not integrity.
* Shared campus Wi-Fi: many users behind one IP only count when they *fail*; raise the limit if needed.
* `check_attempts` grows. Add a periodic cleanup (Phase 2; e.g. delete rows older than a day).
* The 2 s lock timeout also bounds how long a flood can hold database connections.

## Admin accounts

Individual named accounts via Supabase Auth; authorization is the `admins` table (`is_active`). There is no shared
account and no self-registration. Bootstrap: create the user in Supabase Auth, then insert into `admins` using the
SQL editor (see `SETUP_SUPABASE.md`). Deactivate by setting `is_active = false` (takes effect immediately).

## Audit

`audit_log` rows: time, actor (`admin:<uuid>` / `employee:<ID>`), actor user id, action, entity, entity id, before/after
JSON, request id (`x-request-id` header when present, otherwise a generated uuid). Written for: allocation create,
release, reassign; late and re-entry authorizations and revocations; flag create/resolve; **session create/update/
(de)activate; room create/update/(de)activate; session-room assign/capacity/(de)activate/remove; import begin/validate/
cancel/commit/commit_rejected/commit_failed/replace_conflicts; one `schedule.replace` row per replaced schedule row.**
Import audit rows carry the batch id as `entity_id`. **Direct SQL by the project owner is still unaudited**, and a
superuser can disable the immutability triggers; both are platform-owner powers outside the application roles.

Phase 2A notes: every sensitive change records the *before* value; confirmations (`p_confirm`) and reasons are stored in
`after`. Import staging chunks (`admin_import_add_rows`) are not audited individually (volume); the batch is.

-- EOMS Lite — 0004 (Phase 2A): schema additions for admin configuration and schedule import.
-- Additive only: Phase 1 migrations (0001-0003) are not edited.

-- ---------------------------------------------------------------------------
-- Settings: import limits (enforced inside the database, never only in the browser)
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, int_value) values
  ('import_max_file_bytes',  5242880),   -- advisory: the file never reaches the DB, see docs/SCHEDULE_IMPORT.md
  ('import_max_rows',        5000),      -- hard limit on staged rows per batch
  ('import_chunk_max_rows',  500)        -- hard limit on rows per admin_import_add_rows call
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- import_batches: extend the Phase 1 table
-- ---------------------------------------------------------------------------
alter table public.import_batches drop constraint if exists import_batches_status_check;
alter table public.import_batches add constraint import_batches_status_check
  check (status in ('staging', 'validated', 'committed', 'cancelled', 'failed', 'pending', 'rejected'));
alter table public.import_batches alter column status set default 'staging';

alter table public.import_batches
  add column declared_rows           integer,
  add column declared_file_bytes     bigint,
  add column valid_count             integer not null default 0,
  add column invalid_count           integer not null default 0,
  add column duplicate_in_batch_count integer not null default 0,
  add column exact_duplicate_count   integer not null default 0,
  add column conflict_count          integer not null default 0,
  add column inserted_count          integer not null default 0,
  add column replaced_count          integer not null default 0,
  add column validated_at            timestamptz,
  add column committed_at            timestamptz,
  add column committed_by            uuid,
  add column error                   text;

-- ---------------------------------------------------------------------------
-- import_rows: staging area. Rows arrive in bounded chunks, are validated in SQL,
-- and only then (explicit admin action) copied into the live schedule.
-- ---------------------------------------------------------------------------
create table public.import_rows (
  batch_id       uuid not null references public.import_batches (id) on delete cascade,
  row_number     integer not null check (row_number >= 1),
  raw_employee_id text,
  raw_name       text,
  raw_department text,
  raw_date       text,
  raw_session    text,
  employee_id    text,
  employee_name  text,
  department     text,
  exam_date      date,
  session_label  text,
  status         text not null default 'pending'
                   check (status in ('pending', 'valid', 'invalid', 'duplicate_in_batch', 'exact_duplicate', 'conflict')),
  errors         text[] not null default '{}',
  existing       jsonb,
  outcome        text check (outcome in ('inserted', 'skipped_exact_duplicate', 'skipped_conflict',
                                         'skipped_duplicate_in_batch', 'replaced')),
  constraint import_rows_pk primary key (batch_id, row_number)
);
create index import_rows_status_idx on public.import_rows (batch_id, status);

-- ---------------------------------------------------------------------------
-- Guards on Phase 1 tables (defence in depth, so even direct SQL cannot break the invariants)
-- ---------------------------------------------------------------------------

-- A session's identity (date + label) cannot change once it has any allocation history.
create or replace function eoms_private.exam_sessions_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.exam_date, new.session_label) is distinct from (old.exam_date, old.session_label) then
    perform eoms_private.lock_session(old.id);
    if exists (select 1 from public.allocations where session_id = old.id) then
      raise exception 'session date/label cannot change once it has allocations' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger exam_sessions_guard_update
  before update on public.exam_sessions
  for each row execute function eoms_private.exam_sessions_guard_update();

-- Capacity can never drop below the number of ACTIVE allocations; the room/session link is fixed.
create or replace function eoms_private.session_rooms_guard_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active integer;
begin
  if new.session_id <> old.session_id or new.room_id <> old.room_id then
    raise exception 'session_rooms.session_id and room_id are immutable' using errcode = '23514';
  end if;
  if new.max_invigilators < old.max_invigilators then
    perform eoms_private.lock_session(old.session_id);
    select count(*) into v_active
      from public.allocations where session_room_id = old.id and released_at is null;
    if new.max_invigilators < v_active then
      raise exception 'capacity % is below the % active allocations in this room', new.max_invigilators, v_active
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger session_rooms_guard_update
  before update on public.session_rooms
  for each row execute function eoms_private.session_rooms_guard_update();

-- ---------------------------------------------------------------------------
-- Pure helpers for import normalisation
-- ---------------------------------------------------------------------------

-- Accepts YYYY-MM-DD, D-M-YYYY, D/M/YYYY, D.M.YYYY (day first), optionally followed by a time
-- (Excel often exports "2026-11-03 00:00:00"). Returns NULL for anything else or an impossible date.
create or replace function eoms_private.parse_date(p text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  s text := btrim(coalesce(p, ''));
  m text[];
  d date;
begin
  if s = '' then
    return null;
  end if;
  s := regexp_replace(s, '[ T][0-9]{1,2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?$', '');
  m := regexp_match(s, '^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})$');
  if m is not null then
    d := make_date(m[1]::int, m[2]::int, m[3]::int);
  else
    m := regexp_match(s, '^([0-9]{1,2})[-/.]([0-9]{1,2})[-/.]([0-9]{4})$');
    if m is not null then
      d := make_date(m[3]::int, m[2]::int, m[1]::int);
    end if;
  end if;
  if d is null or d < date '2020-01-01' or d > date '2100-12-31' then
    return null;
  end if;
  return d;
exception when others then
  return null;          -- make_date raises for e.g. 31-02
end;
$$;

create or replace function eoms_private.norm_session(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case upper(btrim(coalesce(p, '')))
           when 'FN' then 'FN' when 'FORENOON' then 'FN'
           when 'AN' then 'AN' when 'AFTERNOON' then 'AN'
         end
$$;

-- Parses an admin-supplied LOCAL (Asia/Kolkata) wall-clock timestamp. An explicit UTC offset is rejected on
-- purpose: casting text with an offset to `timestamp` would silently drop it.
create or replace function eoms_private.parse_ist(p text, p_what text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
declare
  s text := btrim(coalesce(p, ''));
begin
  if s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?$' then
    raise exception '% must be local Asia/Kolkata time like 2026-11-03 08:30 (no UTC offset)', p_what
      using errcode = '22023';
  end if;
  return (s::timestamp) at time zone 'Asia/Kolkata';
exception when datetime_field_overflow or invalid_datetime_format then
  raise exception '% is not a valid date/time', p_what using errcode = '22023';
end;
$$;

create or replace function eoms_private.ist_text(p timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$ select to_char(p at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') $$;

-- ---------------------------------------------------------------------------
-- Import validation (set-based; no live-schedule writes). Caller holds responsibility for authz.
-- Re-runnable: every call recomputes normalised values and statuses from the raw staged values.
-- ---------------------------------------------------------------------------
create or replace function eoms_private.import_validate(p_batch uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_valid int; v_invalid int; v_dup int; v_exact int; v_conflict int;
begin
  -- 1. Field-level normalisation and validation. Two ROW-WISE updates (no join on a function-calling
  --    subquery: that made the planner re-evaluate the functions per row and took ~30 s for 5000 rows).
  update public.import_rows r
     set employee_id   = eoms_private.norm_id(r.raw_employee_id),
         employee_name = nullif(regexp_replace(btrim(coalesce(r.raw_name, '')), '\s+', ' ', 'g'), ''),
         department    = nullif(regexp_replace(btrim(coalesce(r.raw_department, '')), '\s+', ' ', 'g'), ''),
         exam_date     = eoms_private.parse_date(r.raw_date),
         session_label = eoms_private.norm_session(r.raw_session)
   where r.batch_id = p_batch;

  update public.import_rows r
     set errors = array_remove(array[
           case when r.raw_employee_id is null or btrim(r.raw_employee_id) = '' then 'Employee ID is missing'
                when r.employee_id !~ '^[A-Z0-9._/-]{1,50}$'
                  then 'Employee ID is invalid (letters, digits and . _ / - only, up to 50 characters)' end,
           case when r.employee_name is null then 'Name is missing'
                when char_length(r.employee_name) > 200 then 'Name is too long (maximum 200 characters)' end,
           case when r.department is null then 'Department is missing'
                when char_length(r.department) > 100 then 'Department is too long (maximum 100 characters)' end,
           case when r.raw_date is null or btrim(r.raw_date) = '' then 'Examination Date is missing'
                when r.exam_date is null then 'Examination Date is not a valid date (use YYYY-MM-DD or DD-MM-YYYY)' end,
           case when r.raw_session is null or btrim(r.raw_session) = '' then 'Session is missing'
                when r.session_label is null then 'Session must be FN, AN, Forenoon or Afternoon' end,
           case when r.exam_date is not null and r.session_label is not null
                     and not exists (select 1 from public.exam_sessions s
                                      where s.exam_date = r.exam_date and s.session_label = r.session_label)
                  then format('No examination session is configured for %s %s', r.exam_date, r.session_label) end
         ], null),
         existing = null,
         outcome = null
   where r.batch_id = p_batch;

  update public.import_rows r
     set status = case when cardinality(r.errors) = 0 then 'valid' else 'invalid' end
   where r.batch_id = p_batch;

  -- 2. Duplicates inside the batch (same employee + date + session).
  --    Identical details: the first row wins, later rows are skipped duplicates.
  --    Different details: ambiguous, every row of the group is invalid (the admin must fix the file).
  --    One pass with window functions, materialised, then joined back by primary key (an UPDATE joined to an
  --    aggregate over the same table was re-evaluated per row by the planner: ~30 s for 5000 rows).
  with dup as materialized (
    select d.row_number, d.n, d.first_row, d.employee_id, d.row_numbers,
           (d.vmin <> d.vmax) as differing
      from (
        select i.row_number, i.employee_id,
               count(*) over w as n,
               min(i.row_number) over w as first_row,
               min(i.employee_name || chr(31) || i.department) over w as vmin,
               max(i.employee_name || chr(31) || i.department) over w as vmax,
               array_agg(i.row_number) over (w order by i.row_number rows between unbounded preceding and unbounded following)
                 as row_numbers
          from public.import_rows i
         where i.batch_id = p_batch and i.status = 'valid'
        window w as (partition by i.employee_id, i.exam_date, i.session_label)
      ) d
     where d.n > 1
  )
  update public.import_rows r
     set status = case when dup.differing then 'invalid' else 'duplicate_in_batch' end,
         errors = case when dup.differing
                       then array[format('Employee %s appears %s times for this session with different details (rows %s)',
                                         dup.employee_id, dup.n, array_to_string(dup.row_numbers, ', '))]
                       else array[format('Duplicate of row %s (skipped)', dup.first_row)] end
    from dup
   where r.batch_id = p_batch and r.row_number = dup.row_number
     and (dup.differing or dup.row_number <> dup.first_row);

  -- 3. Comparison with the live schedule (read-only): identical -> skipped duplicate; different -> conflict.
  update public.import_rows r
     set status = case when s.employee_name = r.employee_name and s.department = r.department
                       then 'exact_duplicate' else 'conflict' end,
         existing = jsonb_build_object('employee_name', s.employee_name, 'department', s.department),
         errors = case when s.employee_name = r.employee_name and s.department = r.department
                       then array['Already scheduled with identical details (skipped)']
                       else array[format('Already scheduled as "%s" in "%s"; needs an administrator decision',
                                         s.employee_name, s.department)] end
    from public.schedule s
   where r.batch_id = p_batch and r.status = 'valid'
     and s.employee_id = r.employee_id and s.exam_date = r.exam_date and s.session_label = r.session_label;

  select count(*) filter (where status = 'valid'),
         count(*) filter (where status = 'invalid'),
         count(*) filter (where status = 'duplicate_in_batch'),
         count(*) filter (where status = 'exact_duplicate'),
         count(*) filter (where status = 'conflict')
    into v_valid, v_invalid, v_dup, v_exact, v_conflict
    from public.import_rows where batch_id = p_batch;

  update public.import_batches
     set valid_count = v_valid, invalid_count = v_invalid, duplicate_in_batch_count = v_dup,
         exact_duplicate_count = v_exact, conflict_count = v_conflict,
         row_count = v_valid + v_invalid + v_dup + v_exact + v_conflict,
         status = 'validated', validated_at = now()
   where id = p_batch;

  return jsonb_build_object(
    'rows', v_valid + v_invalid + v_dup + v_exact + v_conflict,
    'valid', v_valid, 'invalid', v_invalid,
    'duplicate', v_dup + v_exact, 'duplicate_in_batch', v_dup, 'exact_duplicate_existing', v_exact,
    'conflict', v_conflict);
end;
$$;

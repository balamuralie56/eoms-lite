-- EOMS Lite — 0015: bulk session import (Examination Date, Session, Check-in Opens, Check-in Closes, Active).
-- Pattern: SECURITY DEFINER, SET search_path = '', require_admin(), audit row, same validation rules as
-- admin_create_session (eoms_private.validate_window, FN/AN overlap exclusion constraint).
--
-- Opens/Closes are entered as HH:MM (24-hour, Asia/Kolkata), applied to that row's Examination Date — bulk
-- import does not support a window that crosses midnight; use the single "New session" form for that.
--
--   p_confirm = false (default) → dry run: returns {ok, rows, valid, invalid, errors, would_create, would_skip_existing}
--   p_confirm = true            → executes: returns {ok, created, skipped_existing, skipped_overlap}
-- A row whose date+session already exists is skipped (never overwritten — edit it on the Sessions page instead).
-- A row that overlaps another active session's window is skipped too, reported separately; every other
-- valid row still gets created (one bad window should not block fifty good ones).

create or replace function public.admin_import_sessions(
  p_rows    jsonb,
  p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '10s'
as $$
declare
  v_admin    uuid := eoms_private.require_admin();
  v_n        integer;
  v_errors   jsonb := '[]'::jsonb;
  v_valid    integer := 0;
  v_invalid  integer := 0;
  v_create   integer := 0;
  v_skip_existing integer := 0;
  v_skip_overlap  integer := 0;
  v_row      record;
begin
  perform eoms_private.assert_read_committed();

  select coalesce(jsonb_array_length(p_rows), 0) into v_n;
  if v_n = 0 then
    raise exception 'the file has no rows' using errcode = '22023';
  end if;
  if v_n > 500 then
    raise exception 'at most 500 sessions per import (found %)', v_n using errcode = '22023';
  end if;

  -- 1. Validate every row (normalised in-memory; nothing written yet).
  with src as (
    select ord,
           nullif(btrim(coalesce(row->>'exam_date', '')), '') as raw_date,
           eoms_private.parse_date(row->>'exam_date') as exam_date,
           nullif(btrim(coalesce(row->>'session_label', '')), '') as raw_label,
           eoms_private.norm_session(row->>'session_label') as session_label,
           nullif(btrim(coalesce(row->>'opens', '')), '') as raw_opens,
           nullif(btrim(coalesce(row->>'closes', '')), '') as raw_closes,
           nullif(btrim(coalesce(row->>'active', '')), '') as raw_active
      from jsonb_array_elements(p_rows) with ordinality as t(row, ord)
  ),
  checked as (
    select s.*,
           (s.raw_opens ~ '^([0-1][0-9]|2[0-3]):[0-5][0-9]$') as opens_ok,
           (s.raw_closes ~ '^([0-1][0-9]|2[0-3]):[0-5][0-9]$') as closes_ok,
           case when s.raw_active is null then true
                when s.raw_active ~* '^(true|yes|y|1|active)$' then true
                when s.raw_active ~* '^(false|no|n|0|inactive)$' then false end as active
      from src s
  ),
  windowed as (
    select c.*,
           case when c.opens_ok and c.exam_date is not null
                then ((c.exam_date::text || ' ' || c.raw_opens)::timestamp) at time zone 'Asia/Kolkata' end as v_opens,
           case when c.closes_ok and c.exam_date is not null
                then ((c.exam_date::text || ' ' || c.raw_closes)::timestamp) at time zone 'Asia/Kolkata' end as v_closes
      from checked c
  ),
  errored as (
    select w.ord, w.exam_date, w.session_label, errs
      from windowed w, lateral (
        select array_remove(array[
          case when w.raw_date is null then 'Examination Date is missing'
               when w.exam_date is null then 'Examination Date is not a valid date (use YYYY-MM-DD or DD-MM-YYYY)' end,
          case when w.raw_label is null then 'Session is missing'
               when w.session_label is null then 'Session must be FN, AN, Forenoon or Afternoon' end,
          case when w.raw_opens is null then 'Check-in Opens is missing'
               when not w.opens_ok then 'Check-in Opens must be HH:MM, 24-hour (e.g. 07:30)' end,
          case when w.raw_closes is null then 'Check-in Closes is missing'
               when not w.closes_ok then 'Check-in Closes must be HH:MM, 24-hour (e.g. 10:00)' end,
          case when w.raw_active is not null and w.active is null then 'Active must be TRUE/FALSE, Yes/No, or left blank' end,
          case when w.v_opens is not null and w.v_closes is not null and w.v_closes <= w.v_opens
               then 'Check-in Closes must be after Check-in Opens' end
        ], null) as errs
      ) e
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('row', ord, 'exam_date', exam_date, 'session', session_label, 'errors', errs) order by ord) filter (where cardinality(errs) > 0), '[]'::jsonb),
    count(*) filter (where cardinality(errs) = 0),
    count(*) filter (where cardinality(errs) > 0)
    into v_errors, v_valid, v_invalid
  from errored;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', true, 'rows', v_n, 'valid', v_valid, 'invalid', v_invalid, 'errors', v_errors,
      'would_create', 0, 'would_skip_existing', 0);
  end if;

  -- 2. Count what would happen (dry run) — every row is valid at this point.
  select count(*) filter (where s.exam_date is null), count(*) filter (where s.exam_date is not null)
    into v_create, v_skip_existing
  from (
    select eoms_private.parse_date(row->>'exam_date') as exam_date,
           eoms_private.norm_session(row->>'session_label') as session_label
      from jsonb_array_elements(p_rows) as row
  ) x
  left join public.exam_sessions s on s.exam_date = x.exam_date and s.session_label = x.session_label;

  if not coalesce(p_confirm, false) then
    return jsonb_build_object('ok', true, 'rows', v_n, 'valid', v_valid, 'invalid', v_invalid, 'errors', v_errors,
      'would_create', v_create, 'would_skip_existing', v_skip_existing);
  end if;

  -- 3. Execute: insert each new session; a row overlapping another active session's window is skipped,
  --    not fatal to the rest of the file.
  v_create := 0; v_skip_existing := 0; v_skip_overlap := 0;
  for v_row in
    select eoms_private.parse_date(row->>'exam_date') as exam_date,
           eoms_private.norm_session(row->>'session_label') as session_label,
           ((eoms_private.parse_date(row->>'exam_date')::text || ' ' || btrim(row->>'opens'))::timestamp) at time zone 'Asia/Kolkata' as v_opens,
           ((eoms_private.parse_date(row->>'exam_date')::text || ' ' || btrim(row->>'closes'))::timestamp) at time zone 'Asia/Kolkata' as v_closes,
           case when btrim(coalesce(row->>'active', '')) = '' then true
                when (row->>'active') ~* '^(true|yes|y|1|active)$' then true else false end as active
      from jsonb_array_elements(p_rows) as row
  loop
    declare
      v_new public.exam_sessions;
    begin
      if exists (select 1 from public.exam_sessions where exam_date = v_row.exam_date and session_label = v_row.session_label) then
        v_skip_existing := v_skip_existing + 1;
        continue;
      end if;

      begin
        insert into public.exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at, is_active)
        values (v_row.exam_date, v_row.session_label, v_row.v_opens, v_row.v_closes, v_row.active)
        returning * into v_new;
      exception when exclusion_violation then
        v_skip_overlap := v_skip_overlap + 1;
        continue;
      end;

      v_create := v_create + 1;
      perform eoms_private.audit('admin:' || v_admin, v_admin, 'session.create', 'exam_session', v_new.id::text,
        null, eoms_private.session_json(v_new) || jsonb_build_object('via', 'bulk_import'));
    end;
  end loop;

  return jsonb_build_object('ok', true, 'created', v_create, 'skipped_existing', v_skip_existing, 'skipped_overlap', v_skip_overlap);
end;
$$;

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_import_sessions'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

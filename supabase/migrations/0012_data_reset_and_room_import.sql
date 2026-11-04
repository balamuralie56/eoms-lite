-- EOMS Lite — 0012: full data export/reset, and bulk room import (code + building + floor + capacity).
-- Pattern: SECURITY DEFINER, SET search_path = '', require_admin(), audit row. Additive; earlier migrations
-- are not edited.

-- ---------------------------------------------------------------------------
-- admin_export_all_data: everything an admin can later need to restore or archive, as one JSON document.
-- Read-only. The client turns this into a downloadable zip; nothing is deleted here.
-- ---------------------------------------------------------------------------
create or replace function public.admin_export_all_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin uuid := eoms_private.require_admin();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'exported_by', v_admin,
    'exam_sessions',        (select coalesce(jsonb_agg(to_jsonb(t) order by t.exam_date, t.session_label), '[]'::jsonb) from public.exam_sessions t),
    'rooms',                (select coalesce(jsonb_agg(to_jsonb(t) order by t.room_code), '[]'::jsonb) from public.rooms t),
    'session_rooms',        (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.session_rooms t),
    'schedule',             (select coalesce(jsonb_agg(to_jsonb(t) order by t.exam_date, t.session_label, t.employee_id), '[]'::jsonb) from public.schedule t),
    'allocations',          (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]'::jsonb) from public.allocations t),
    'employee_flags',       (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at), '[]'::jsonb) from public.employee_flags t),
    'admin_authorizations', (select coalesce(jsonb_agg(to_jsonb(t) order by t.authorized_at), '[]'::jsonb) from public.admin_authorizations t),
    'import_batches',       (select coalesce(jsonb_agg(to_jsonb(t) order by t.uploaded_at), '[]'::jsonb) from public.import_batches t),
    'check_attempts',       (select coalesce(jsonb_agg(to_jsonb(t) order by t.at), '[]'::jsonb) from public.check_attempts t),
    'audit_log',            (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from public.audit_log t)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_reset_all_data: wipes operational data back to a clean state.
--   p_confirm = false (default) → dry run: returns {ok, dry_run: true, would_delete: {...counts}}
--   p_confirm = true            → executes: returns {ok, dry_run: false, deleted: {...counts}}
-- Preserved on purpose: admin accounts (public.admins), branding (public.app_branding), and
-- retention/import settings (public.app_settings) — so an admin can log in immediately afterward.
-- The audit log itself is included (exported first, then wiped); exactly one new row records the reset.
-- ---------------------------------------------------------------------------
create or replace function public.admin_reset_all_data(p_confirm boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '10s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_counts jsonb;
begin
  select jsonb_build_object(
    'sessions',        (select count(*) from public.exam_sessions),
    'rooms',           (select count(*) from public.rooms),
    'session_rooms',   (select count(*) from public.session_rooms),
    'schedule',        (select count(*) from public.schedule),
    'allocations',     (select count(*) from public.allocations),
    'flags',           (select count(*) from public.employee_flags),
    'authorizations',  (select count(*) from public.admin_authorizations),
    'import_batches',  (select count(*) from public.import_batches),
    'import_rows',     (select count(*) from public.import_rows),
    'check_attempts',  (select count(*) from public.check_attempts),
    'audit_log',       (select count(*) from public.audit_log)
  ) into v_counts;

  if not coalesce(p_confirm, false) then
    return jsonb_build_object('ok', true, 'dry_run', true, 'would_delete', v_counts);
  end if;

  -- Deliberately lift the immutability/no-delete safeguards for this one admin-confirmed,
  -- password-reverified reset. Postgres DDL is transactional: if anything below raises,
  -- the whole transaction (including these ALTER TABLEs) rolls back and nothing is lost.
  execute 'alter table public.allocations disable trigger allocations_no_delete';
  execute 'alter table public.allocations disable trigger allocations_no_truncate';
  execute 'alter table public.audit_log disable trigger audit_log_no_update_delete';
  execute 'alter table public.audit_log disable trigger audit_log_no_truncate';

  delete from public.import_rows;
  delete from public.import_batches;
  delete from public.check_attempts;
  delete from public.allocations;
  delete from public.admin_authorizations;
  delete from public.employee_flags;
  delete from public.schedule;
  delete from public.session_rooms;
  delete from public.exam_sessions;
  delete from public.rooms;
  delete from public.audit_log;

  execute 'alter table public.allocations enable trigger allocations_no_delete';
  execute 'alter table public.allocations enable trigger allocations_no_truncate';
  execute 'alter table public.audit_log enable trigger audit_log_no_update_delete';
  execute 'alter table public.audit_log enable trigger audit_log_no_truncate';

  insert into public.audit_log (actor, actor_user_id, action, entity, entity_id, before, after)
  values ('admin:' || v_admin, v_admin, 'system.full_reset', 'database', null, v_counts, jsonb_build_object('ok', true));

  return jsonb_build_object('ok', true, 'dry_run', false, 'deleted', v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_import_rooms: bulk create/update rooms AND assign them to one session with a capacity, in one call.
-- Rows: [{room_code, building?, floor?, capacity}]. Every row is validated before anything is written —
-- same "a bad file is never half-imported" rule as the schedule import.
--   p_confirm = false (default) → dry run: returns {ok, rows, valid, invalid, errors,
--                                                    would_create_rooms, would_update_rooms, would_assign, would_update_capacity}
--   p_confirm = true            → executes: returns {ok, created_rooms, updated_rooms, assigned, updated_capacity, unchanged}
-- ---------------------------------------------------------------------------
create or replace function public.admin_import_rooms(
  p_session_id uuid,
  p_rows       jsonb,
  p_confirm    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '10s'
as $$
declare
  v_admin   uuid := eoms_private.require_admin();
  v_n       integer;
  v_errors  jsonb := '[]'::jsonb;
  v_valid   integer := 0;
  v_invalid integer := 0;
  v_create  integer := 0;
  v_update_room integer := 0;
  v_assign  integer := 0;
  v_update_cap  integer := 0;
  v_unchanged   integer := 0;
  v_row     record;
begin
  perform eoms_private.assert_read_committed();

  if not exists (select 1 from public.exam_sessions where id = p_session_id) then
    raise exception 'session not found' using errcode = '22023';
  end if;

  select coalesce(jsonb_array_length(p_rows), 0) into v_n;
  if v_n = 0 then
    raise exception 'the file has no rows' using errcode = '22023';
  end if;
  if v_n > 1000 then
    raise exception 'at most 1000 rooms per import (found %)', v_n using errcode = '22023';
  end if;

  perform eoms_private.lock_session(p_session_id);

  -- 1. Validate every row (normalised in-memory; nothing written yet). A room code appearing more
  --    than once in the file is ambiguous, so every occurrence of it is treated as invalid too.
  with src as (
    select ord,
           upper(btrim(coalesce(row->>'room_code', ''))) as room_code,
           nullif(btrim(coalesce(row->>'building', '')), '') as building,
           nullif(btrim(coalesce(row->>'floor', '')), '') as floor,
           row->>'capacity' as raw_capacity
      from jsonb_array_elements(p_rows) with ordinality as t(row, ord)
  ),
  checked as (
    select *, count(*) over (partition by room_code) as dup_n from src
  ),
  errored as (
    select ord, room_code, errs
      from checked, lateral (
        select array_remove(array[
          case when room_code = '' then 'Room code is missing'
               when room_code !~ '^[A-Z0-9._/ -]{1,50}$' then 'Room code is invalid (up to 50 characters)' end,
          case when room_code <> '' and dup_n > 1 then 'Room code appears more than once in this file' end,
          case when char_length(coalesce(building, '')) > 100 then 'Building is too long (maximum 100 characters)' end,
          case when char_length(coalesce(floor, '')) > 100 then 'Floor is too long (maximum 100 characters)' end,
          case when raw_capacity is null or btrim(raw_capacity) = '' then 'Capacity is missing'
               when raw_capacity !~ '^[0-9]+$' then 'Capacity must be a whole number'
               when raw_capacity::integer < 1 or raw_capacity::integer > 100 then 'Capacity must be between 1 and 100' end
        ], null) as errs
      ) e
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('row', ord, 'room_code', room_code, 'errors', errs) order by ord) filter (where cardinality(errs) > 0), '[]'::jsonb),
    count(*) filter (where cardinality(errs) = 0),
    count(*) filter (where cardinality(errs) > 0)
    into v_errors, v_valid, v_invalid
  from errored;

  if jsonb_array_length(v_errors) > 0 then
    return jsonb_build_object('ok', true, 'rows', v_n, 'valid', v_valid, 'invalid', v_invalid, 'errors', v_errors,
      'would_create_rooms', 0, 'would_update_rooms', 0, 'would_assign', 0, 'would_update_capacity', 0);
  end if;

  -- 2. Count what would change (dry run) — every row is valid and unique at this point.
  select
    count(*) filter (where r.id is null),
    count(*) filter (where r.id is not null and (r.building is distinct from x.building or r.floor is distinct from x.floor)),
    count(*) filter (where sr.id is null),
    count(*) filter (where sr.id is not null and sr.max_invigilators <> x.capacity)
    into v_create, v_update_room, v_assign, v_update_cap
  from (
    select upper(btrim(coalesce(row->>'room_code', ''))) as room_code,
           nullif(btrim(coalesce(row->>'building', '')), '') as building,
           nullif(btrim(coalesce(row->>'floor', '')), '') as floor,
           (row->>'capacity')::integer as capacity
      from jsonb_array_elements(p_rows) as row
  ) x
  left join public.rooms r on r.room_code = x.room_code
  left join public.session_rooms sr on sr.session_id = p_session_id and sr.room_id = r.id;

  if not coalesce(p_confirm, false) then
    return jsonb_build_object('ok', true, 'rows', v_n, 'valid', v_valid, 'invalid', v_invalid, 'errors', v_errors,
      'would_create_rooms', v_create, 'would_update_rooms', v_update_room, 'would_assign', v_assign, 'would_update_capacity', v_update_cap);
  end if;

  -- 3. Execute: upsert each room, then upsert its capacity for this session.
  v_create := 0; v_update_room := 0; v_assign := 0; v_update_cap := 0; v_unchanged := 0;
  for v_row in
    select upper(btrim(coalesce(row->>'room_code', ''))) as room_code,
           nullif(btrim(coalesce(row->>'building', '')), '') as building,
           nullif(btrim(coalesce(row->>'floor', '')), '') as floor,
           (row->>'capacity')::integer as capacity
      from jsonb_array_elements(p_rows) as row
  loop
    declare
      v_before public.rooms;
      v_after  public.rooms;
      v_cap_before integer;
    begin
      select * into v_before from public.rooms where room_code = v_row.room_code;
      if v_before.id is null then
        insert into public.rooms (room_code, building, floor) values (v_row.room_code, v_row.building, v_row.floor)
          returning * into v_after;
        v_create := v_create + 1;
        perform eoms_private.audit('admin:' || v_admin, v_admin, 'room.create', 'room', v_after.id::text, null, eoms_private.room_json(v_after));
      elsif v_before.building is distinct from v_row.building or v_before.floor is distinct from v_row.floor then
        update public.rooms set building = v_row.building, floor = v_row.floor where id = v_before.id returning * into v_after;
        v_update_room := v_update_room + 1;
        perform eoms_private.audit('admin:' || v_admin, v_admin, 'room.update', 'room', v_after.id::text, eoms_private.room_json(v_before), eoms_private.room_json(v_after));
      else
        v_after := v_before;
      end if;

      select max_invigilators into v_cap_before from public.session_rooms where session_id = p_session_id and room_id = v_after.id;
      if v_cap_before is null then
        insert into public.session_rooms (session_id, room_id, max_invigilators) values (p_session_id, v_after.id, v_row.capacity);
        v_assign := v_assign + 1;
        perform eoms_private.audit('admin:' || v_admin, v_admin, 'session_room.assign', 'session_room', v_after.id::text,
          null, jsonb_build_object('session_id', p_session_id, 'room_id', v_after.id, 'max_invigilators', v_row.capacity));
      elsif v_cap_before <> v_row.capacity then
        update public.session_rooms set max_invigilators = v_row.capacity where session_id = p_session_id and room_id = v_after.id;
        v_update_cap := v_update_cap + 1;
        perform eoms_private.audit('admin:' || v_admin, v_admin, 'session_room.update', 'session_room', v_after.id::text,
          jsonb_build_object('max_invigilators', v_cap_before), jsonb_build_object('max_invigilators', v_row.capacity));
      else
        v_unchanged := v_unchanged + 1;
      end if;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'created_rooms', v_create, 'updated_rooms', v_update_room,
    'assigned', v_assign, 'updated_capacity', v_update_cap, 'unchanged', v_unchanged);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (same pattern as 0007 / 0010 / 0011)
-- ---------------------------------------------------------------------------
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('admin_export_all_data', 'admin_reset_all_data', 'admin_import_rooms')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

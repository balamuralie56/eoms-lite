-- EOMS Lite — 0005 (Phase 2A): audited admin RPCs for sessions, rooms and per-session room configuration.
--
-- Every function: SECURITY DEFINER, SET search_path = '', fully qualified names, no dynamic SQL,
-- admin identity ONLY from auth.uid() via eoms_private.require_admin(), audit row written in the same transaction.
-- Anything that can change what the allocation engine sees takes the SAME per-session advisory lock
-- (eoms_private.lock_session) as employee allocation, so configuration cannot race with check-ins.
-- EXECUTE grants are in 0007.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function eoms_private.session_json(s public.exam_sessions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id,
    'exam_date', s.exam_date,
    'session', s.session_label,
    'checkin_opens_at_ist', eoms_private.ist_text(s.checkin_opens_at),
    'checkin_closes_at_ist', eoms_private.ist_text(s.checkin_closes_at),
    'is_active', s.is_active)
$$;

-- Sanity rules for a check-in window (all comparisons in Asia/Kolkata wall-clock terms).
create or replace function eoms_private.validate_window(p_date date, p_opens timestamptz, p_closes timestamptz)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_date is null then
    raise exception 'exam date is required' using errcode = '22023';
  end if;
  if p_closes <= p_opens then
    raise exception 'check-in closing time must be after opening time' using errcode = '22023';
  end if;
  if p_closes - p_opens > interval '24 hours' then
    raise exception 'check-in window cannot be longer than 24 hours' using errcode = '22023';
  end if;
  if (p_opens at time zone 'Asia/Kolkata')::date > p_date or (p_closes at time zone 'Asia/Kolkata')::date < p_date then
    raise exception 'check-in window must include the examination date (Asia/Kolkata)' using errcode = '22023';
  end if;
end;
$$;

create or replace function eoms_private.require_capacity(p int)
returns int
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or p < 1 or p > 100 then
    raise exception 'maximum invigilators must be between 1 and 100' using errcode = '22023';
  end if;
  return p;
end;
$$;

-- Locks every session the room is configured in, in id order (consistent order => no deadlocks between admins).
create or replace function eoms_private.lock_room_sessions(p_room uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_session uuid;
begin
  for v_session in
    select distinct session_id from public.session_rooms where room_id = p_room order by session_id
  loop
    perform eoms_private.lock_session(v_session);
  end loop;
end;
$$;

create or replace function eoms_private.room_json(r public.rooms)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', r.id, 'room_code', r.room_code, 'building', r.building,
                            'floor', r.floor, 'is_active', r.is_active)
$$;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_session(
  p_exam_date date, p_session_label text, p_opens_local text, p_closes_local text,
  p_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_label  text := eoms_private.norm_session(p_session_label);
  v_opens  timestamptz := eoms_private.parse_ist(p_opens_local, 'check-in opening time');
  v_closes timestamptz := eoms_private.parse_ist(p_closes_local, 'check-in closing time');
  v_s      public.exam_sessions;
begin
  perform eoms_private.assert_read_committed();
  if v_label is null then
    raise exception 'session must be FN or AN' using errcode = '22023';
  end if;
  perform eoms_private.validate_window(p_exam_date, v_opens, v_closes);

  begin
    insert into public.exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at, is_active)
    values (p_exam_date, v_label, v_opens, v_closes, coalesce(p_is_active, true))
    returning * into v_s;
  exception
    when exclusion_violation then
      raise exception 'this check-in window overlaps another active session' using errcode = '23P01';
    when unique_violation then
      raise exception 'a session for % % already exists', p_exam_date, v_label using errcode = '23505';
  end;

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'session.create', 'exam_session', v_s.id::text,
    null, eoms_private.session_json(v_s));
  return jsonb_build_object('ok', true, 'session', eoms_private.session_json(v_s));
end;
$$;

-- NULL argument = leave unchanged. Date/label are frozen once the session has allocation or schedule history.
create or replace function public.admin_update_session(
  p_session_id uuid, p_exam_date date default null, p_session_label text default null,
  p_opens_local text default null, p_closes_local text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_old    public.exam_sessions;
  v_new    public.exam_sessions;
  v_date   date;
  v_label  text;
  v_opens  timestamptz;
  v_closes timestamptz;
begin
  perform eoms_private.assert_read_committed();
  if not exists (select 1 from public.exam_sessions where id = p_session_id) then
    raise exception 'session not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(p_session_id);        -- same lock as allocation
  select * into v_old from public.exam_sessions where id = p_session_id;

  v_date  := coalesce(p_exam_date, v_old.exam_date);
  v_label := case when p_session_label is null then v_old.session_label
                  else eoms_private.norm_session(p_session_label) end;
  if v_label is null then
    raise exception 'session must be FN or AN' using errcode = '22023';
  end if;
  v_opens  := case when p_opens_local is null then v_old.checkin_opens_at
                   else eoms_private.parse_ist(p_opens_local, 'check-in opening time') end;
  v_closes := case when p_closes_local is null then v_old.checkin_closes_at
                   else eoms_private.parse_ist(p_closes_local, 'check-in closing time') end;
  perform eoms_private.validate_window(v_date, v_opens, v_closes);

  if (v_date, v_label) is distinct from (v_old.exam_date, v_old.session_label) then
    if exists (select 1 from public.allocations where session_id = p_session_id) then
      raise exception 'date/session cannot change: this session already has allocations' using errcode = '23514';
    end if;
    if exists (select 1 from public.schedule
                where exam_date = v_old.exam_date and session_label = v_old.session_label) then
      raise exception 'date/session cannot change: the schedule already references %, %. Create a new session instead',
        v_old.exam_date, v_old.session_label using errcode = '23514';
    end if;
  end if;

  begin
    update public.exam_sessions
       set exam_date = v_date, session_label = v_label, checkin_opens_at = v_opens, checkin_closes_at = v_closes
     where id = p_session_id
     returning * into v_new;
  exception
    when exclusion_violation then
      raise exception 'this check-in window overlaps another active session' using errcode = '23P01';
    when unique_violation then
      raise exception 'a session for % % already exists', v_date, v_label using errcode = '23505';
  end;

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'session.update', 'exam_session', p_session_id::text,
    eoms_private.session_json(v_old), eoms_private.session_json(v_new));
  return jsonb_build_object('ok', true, 'session', eoms_private.session_json(v_new));
end;
$$;

create or replace function public.admin_set_session_active(
  p_session_id uuid, p_active boolean, p_reason text, p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_reason text := eoms_private.require_reason(p_reason);
  v_old    public.exam_sessions;
  v_new    public.exam_sessions;
  v_active integer;
begin
  perform eoms_private.assert_read_committed();
  if p_active is null then
    raise exception 'active flag is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.exam_sessions where id = p_session_id) then
    raise exception 'session not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(p_session_id);
  select * into v_old from public.exam_sessions where id = p_session_id;
  if v_old.is_active = p_active then
    return jsonb_build_object('ok', true, 'unchanged', true, 'session', eoms_private.session_json(v_old));
  end if;

  select count(*) into v_active from public.allocations where session_id = p_session_id and released_at is null;
  if not p_active and v_active > 0 and not coalesce(p_confirm, false) then
    raise exception 'session has % active allocations; deactivating stops check-in. Pass p_confirm = true to proceed', v_active
      using errcode = '22023';
  end if;

  begin
    update public.exam_sessions set is_active = p_active where id = p_session_id returning * into v_new;
  exception when exclusion_violation then
    raise exception 'cannot activate: the check-in window overlaps another active session' using errcode = '23P01';
  end;

  perform eoms_private.audit('admin:' || v_admin, v_admin,
    case when p_active then 'session.activate' else 'session.deactivate' end,
    'exam_session', p_session_id::text,
    eoms_private.session_json(v_old),
    eoms_private.session_json(v_new) || jsonb_build_object('reason', v_reason, 'active_allocations', v_active));
  return jsonb_build_object('ok', true, 'session', eoms_private.session_json(v_new), 'active_allocations', v_active);
end;
$$;

-- ---------------------------------------------------------------------------
-- Rooms (physical rooms; invigilator capacity lives on session_rooms, never here)
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_room(
  p_room_code text, p_building text default null, p_floor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin uuid := eoms_private.require_admin();
  v_code  text := upper(btrim(coalesce(p_room_code, '')));
  v_r     public.rooms;
begin
  if v_code = '' or char_length(v_code) > 50 then
    raise exception 'room code is required (maximum 50 characters)' using errcode = '22023';
  end if;
  if char_length(coalesce(p_building, '')) > 100 or char_length(coalesce(p_floor, '')) > 100 then
    raise exception 'building/floor too long (maximum 100 characters)' using errcode = '22023';
  end if;
  begin
    insert into public.rooms (room_code, building, floor)
    values (v_code, nullif(btrim(p_building), ''), nullif(btrim(p_floor), ''))
    returning * into v_r;
  exception when unique_violation then
    raise exception 'room code % already exists', v_code using errcode = '23505';
  end;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'room.create', 'room', v_r.id::text,
    null, eoms_private.room_json(v_r));
  return jsonb_build_object('ok', true, 'room', eoms_private.room_json(v_r));
end;
$$;

-- NULL argument = unchanged; empty string clears building/floor. Changing what existing slips show
-- (code/building/floor) while the room holds active allocations requires p_confirm = true.
create or replace function public.admin_update_room(
  p_room_id uuid, p_room_code text default null, p_building text default null,
  p_floor text default null, p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_old    public.rooms;
  v_new    public.rooms;
  v_code   text;
  v_active integer;
begin
  perform eoms_private.assert_read_committed();
  if not exists (select 1 from public.rooms where id = p_room_id) then
    raise exception 'room not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_room_sessions(p_room_id);
  select * into v_old from public.rooms where id = p_room_id;

  v_code := case when p_room_code is null then v_old.room_code else upper(btrim(p_room_code)) end;
  if v_code = '' or char_length(v_code) > 50 then
    raise exception 'room code is required (maximum 50 characters)' using errcode = '22023';
  end if;
  if char_length(coalesce(p_building, '')) > 100 or char_length(coalesce(p_floor, '')) > 100 then
    raise exception 'building/floor too long (maximum 100 characters)' using errcode = '22023';
  end if;

  select count(*) into v_active
    from public.allocations a join public.session_rooms sr on sr.id = a.session_room_id
   where sr.room_id = p_room_id and a.released_at is null;

  if v_active > 0 and not coalesce(p_confirm, false)
     and (v_code is distinct from v_old.room_code
          or (p_building is not null and nullif(btrim(p_building), '') is distinct from v_old.building)
          or (p_floor is not null and nullif(btrim(p_floor), '') is distinct from v_old.floor)) then
    raise exception 'room has % active allocations whose slips show the current details. Pass p_confirm = true to change them', v_active
      using errcode = '22023';
  end if;

  begin
    update public.rooms
       set room_code = v_code,
           building  = case when p_building is null then building else nullif(btrim(p_building), '') end,
           floor     = case when p_floor is null then floor else nullif(btrim(p_floor), '') end
     where id = p_room_id
     returning * into v_new;
  exception when unique_violation then
    raise exception 'room code % already exists', v_code using errcode = '23505';
  end;

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'room.update', 'room', p_room_id::text,
    eoms_private.room_json(v_old), eoms_private.room_json(v_new) || jsonb_build_object('active_allocations', v_active));
  return jsonb_build_object('ok', true, 'room', eoms_private.room_json(v_new));
end;
$$;

create or replace function public.admin_set_room_active(
  p_room_id uuid, p_active boolean, p_reason text, p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_reason text := eoms_private.require_reason(p_reason);
  v_old    public.rooms;
  v_new    public.rooms;
  v_active integer;
begin
  perform eoms_private.assert_read_committed();
  if p_active is null then
    raise exception 'active flag is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.rooms where id = p_room_id) then
    raise exception 'room not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_room_sessions(p_room_id);
  select * into v_old from public.rooms where id = p_room_id;
  if v_old.is_active = p_active then
    return jsonb_build_object('ok', true, 'unchanged', true, 'room', eoms_private.room_json(v_old));
  end if;

  select count(*) into v_active
    from public.allocations a join public.session_rooms sr on sr.id = a.session_room_id
   where sr.room_id = p_room_id and a.released_at is null;
  if not p_active and v_active > 0 and not coalesce(p_confirm, false) then
    raise exception 'room has % active allocations; deactivating stops NEW allocations into it (existing ones stay). Pass p_confirm = true to proceed', v_active
      using errcode = '22023';
  end if;

  update public.rooms set is_active = p_active where id = p_room_id returning * into v_new;
  perform eoms_private.audit('admin:' || v_admin, v_admin,
    case when p_active then 'room.activate' else 'room.deactivate' end, 'room', p_room_id::text,
    eoms_private.room_json(v_old),
    eoms_private.room_json(v_new) || jsonb_build_object('reason', v_reason, 'active_allocations', v_active));
  return jsonb_build_object('ok', true, 'room', eoms_private.room_json(v_new), 'active_allocations', v_active);
end;
$$;

-- ---------------------------------------------------------------------------
-- Per-session room configuration (invigilator capacity + eligibility)
-- ---------------------------------------------------------------------------

create or replace function eoms_private.session_room_json(sr public.session_rooms)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', sr.id, 'session_id', sr.session_id, 'room_id', sr.room_id,
                            'max_invigilators', sr.max_invigilators, 'is_active', sr.is_active)
$$;

create or replace function public.admin_assign_room_to_session(
  p_session_id uuid, p_room_id uuid, p_max_invigilators integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin uuid := eoms_private.require_admin();
  v_cap   integer := eoms_private.require_capacity(p_max_invigilators);
  v_sr    public.session_rooms;
begin
  perform eoms_private.assert_read_committed();
  if not exists (select 1 from public.exam_sessions where id = p_session_id) then
    raise exception 'session not found' using errcode = '22023';
  end if;
  if not exists (select 1 from public.rooms where id = p_room_id) then
    raise exception 'room not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(p_session_id);
  begin
    insert into public.session_rooms (session_id, room_id, max_invigilators)
    values (p_session_id, p_room_id, v_cap) returning * into v_sr;
  exception when unique_violation then
    raise exception 'this room is already assigned to the session' using errcode = '23505';
  end;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'session_room.assign', 'session_room', v_sr.id::text,
    null, eoms_private.session_room_json(v_sr));
  return jsonb_build_object('ok', true, 'session_room', eoms_private.session_room_json(v_sr));
end;
$$;

create or replace function public.admin_update_session_room(p_session_room_id uuid, p_max_invigilators integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_cap    integer := eoms_private.require_capacity(p_max_invigilators);
  v_old    public.session_rooms;
  v_new    public.session_rooms;
  v_active integer;
begin
  perform eoms_private.assert_read_committed();
  select * into v_old from public.session_rooms where id = p_session_room_id;
  if v_old.id is null then
    raise exception 'session room not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(v_old.session_id);
  select * into v_old from public.session_rooms where id = p_session_room_id;     -- re-read under lock

  select count(*) into v_active
    from public.allocations where session_room_id = p_session_room_id and released_at is null;
  if v_cap < v_active then
    raise exception 'cannot reduce capacity to %: the room has % active allocations. Release or move some first', v_cap, v_active
      using errcode = '23514';
  end if;

  update public.session_rooms set max_invigilators = v_cap where id = p_session_room_id returning * into v_new;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'session_room.update_capacity', 'session_room',
    p_session_room_id::text, eoms_private.session_room_json(v_old),
    eoms_private.session_room_json(v_new) || jsonb_build_object('active_allocations', v_active));
  return jsonb_build_object('ok', true, 'session_room', eoms_private.session_room_json(v_new));
end;
$$;

create or replace function public.admin_set_session_room_active(
  p_session_room_id uuid, p_active boolean, p_reason text, p_confirm boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_reason text := eoms_private.require_reason(p_reason);
  v_old    public.session_rooms;
  v_new    public.session_rooms;
  v_active integer;
begin
  perform eoms_private.assert_read_committed();
  if p_active is null then
    raise exception 'active flag is required' using errcode = '22023';
  end if;
  select * into v_old from public.session_rooms where id = p_session_room_id;
  if v_old.id is null then
    raise exception 'session room not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(v_old.session_id);
  select * into v_old from public.session_rooms where id = p_session_room_id;
  if v_old.is_active = p_active then
    return jsonb_build_object('ok', true, 'unchanged', true, 'session_room', eoms_private.session_room_json(v_old));
  end if;

  select count(*) into v_active
    from public.allocations where session_room_id = p_session_room_id and released_at is null;
  if not p_active and v_active > 0 and not coalesce(p_confirm, false) then
    raise exception 'room has % active allocations in this session; deactivating stops NEW allocations into it. Pass p_confirm = true to proceed', v_active
      using errcode = '22023';
  end if;

  update public.session_rooms set is_active = p_active where id = p_session_room_id returning * into v_new;
  perform eoms_private.audit('admin:' || v_admin, v_admin,
    case when p_active then 'session_room.activate' else 'session_room.deactivate' end,
    'session_room', p_session_room_id::text, eoms_private.session_room_json(v_old),
    eoms_private.session_room_json(v_new) || jsonb_build_object('reason', v_reason, 'active_allocations', v_active));
  return jsonb_build_object('ok', true, 'session_room', eoms_private.session_room_json(v_new), 'active_allocations', v_active);
end;
$$;

-- Removal is only possible while the link has NO allocation history; otherwise deactivate it.
create or replace function public.admin_remove_session_room(p_session_room_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_reason text := eoms_private.require_reason(p_reason);
  v_old    public.session_rooms;
begin
  perform eoms_private.assert_read_committed();
  select * into v_old from public.session_rooms where id = p_session_room_id;
  if v_old.id is null then
    raise exception 'session room not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(v_old.session_id);
  if exists (select 1 from public.allocations where session_room_id = p_session_room_id) then
    raise exception 'this room has allocation history in the session and cannot be removed; deactivate it instead'
      using errcode = '23514';
  end if;

  delete from public.session_rooms where id = p_session_room_id;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'session_room.remove', 'session_room',
    p_session_room_id::text, eoms_private.session_room_json(v_old), jsonb_build_object('reason', v_reason));
  return jsonb_build_object('ok', true);
end;
$$;

-- EOMS Lite — 0009 (product phase): read-only admin RPCs for the portal (dashboard, monitor, lists, audit, reports).
--
-- All are SECURITY DEFINER, STABLE, search_path = '', and call eoms_private.require_admin() first, so a non-admin
-- gets 'not authorized' and nothing else. They never modify data. Search terms are bound parameters used with
-- ILIKE ... ESCAPE (no dynamic SQL). Page sizes are capped server-side. EXECUTE grants are in 0010.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function eoms_private.like_pattern(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select case when btrim(coalesce(p, '')) = '' then null
                  else '%' || replace(replace(replace(btrim(p), '\', '\\'), '%', '\%'), '_', '\_') || '%' end $$;

create or replace function eoms_private.page_limit(p integer, p_max integer default 500)
returns integer
language sql
immutable
set search_path = ''
as $$ select greatest(1, least(coalesce(p, 25), p_max)) $$;

create or replace function eoms_private.page_offset(p integer)
returns integer
language sql
immutable
set search_path = ''
as $$ select greatest(0, coalesce(p, 0)) $$;

create or replace function eoms_private.admin_name(p uuid)
returns text
language sql
stable
set search_path = ''
as $$ select coalesce((select a.display_name from public.admins a where a.user_id = p), p::text) $$;

create or replace function eoms_private.ist_ts(p timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$ select to_char(p at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') $$;

-- Dashboard session: the explicit one, else the open session, else the next upcoming active, else the latest ended.
create or replace function eoms_private.pick_session(p_id uuid)
returns public.exam_sessions
language plpgsql
stable
set search_path = ''
as $$
declare
  v_s   public.exam_sessions;
  v_now timestamptz := now();
begin
  if p_id is not null then
    select * into v_s from public.exam_sessions where id = p_id;
    return v_s;
  end if;
  select * into v_s from public.exam_sessions
   where is_active and checkin_opens_at <= v_now and v_now < checkin_closes_at limit 1;
  if v_s.id is not null then return v_s; end if;
  select * into v_s from public.exam_sessions
   where is_active and checkin_opens_at > v_now order by checkin_opens_at limit 1;
  if v_s.id is not null then return v_s; end if;
  select * into v_s from public.exam_sessions
   where is_active order by checkin_closes_at desc limit 1;
  return v_s;
end;
$$;

-- One row per scheduled employee with their state in that session.
--   allocated: active allocation   released: only released allocations   flagged: pending/blocked flag   pending: none
create or replace function eoms_private.schedule_state(p_session_id uuid)
returns table (
  employee_id text, employee_name text, department text, exam_date date, session_label text,
  import_batch_id uuid, session_id uuid, state text, room_code text, building text, floor text,
  allocated_at timestamptz, round integer
)
language sql
stable
set search_path = ''
as $$
  select s.employee_id, s.employee_name, s.department, s.exam_date, s.session_label, s.import_batch_id, es.id,
         case when la.id is not null and la.released_at is null then 'allocated'
              when la.id is not null then 'released'
              when es.id is not null and exists (select 1 from public.employee_flags f
                                                  where f.session_id = es.id and f.employee_id = s.employee_id
                                                    and f.status in ('pending', 'blocked')) then 'flagged'
              else 'pending' end,
         r.room_code, r.building, r.floor, la.allocated_at, la.round
    from public.schedule s
    left join public.exam_sessions es on es.exam_date = s.exam_date and es.session_label = s.session_label
    left join lateral (select a.* from public.allocations a
                        where a.session_id = es.id and a.employee_id = s.employee_id
                        order by a.seq desc limit 1) la on true
    left join public.session_rooms sr on sr.id = la.session_room_id
    left join public.rooms r on r.id = sr.room_id
   where p_session_id is null or es.id = p_session_id
$$;

-- ---------------------------------------------------------------------------
-- Dashboard and live monitor
-- ---------------------------------------------------------------------------
create or replace function public.admin_overview(p_session_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now       timestamptz := now();
  v_s         public.exam_sessions;
  v_state     text;
  v_scheduled integer;
  v_alloc     integer;
  v_pending   integer;
  v_flagged   integer;
  v_released  integer;
  v_act_rooms integer;
  v_full      integer;
  v_slots     integer;
  v_avail     integer;
  v_recent    jsonb;
begin
  perform eoms_private.require_admin();
  v_s := eoms_private.pick_session(p_session_id);
  if v_s.id is null then
    return jsonb_build_object('session', null, 'state', 'NONE', 'server_time', v_now, 'counts', null, 'recent', '[]'::jsonb);
  end if;
  v_state := case when not v_s.is_active then 'INACTIVE'
                  when v_now < v_s.checkin_opens_at then 'UPCOMING'
                  when v_now >= v_s.checkin_closes_at then 'CLOSED'
                  else 'OPEN' end;

  select count(*) into v_scheduled from public.schedule
   where exam_date = v_s.exam_date and session_label = v_s.session_label;
  select count(*) into v_alloc from public.allocations where session_id = v_s.id and released_at is null;
  select count(*) into v_pending from public.schedule sc
   where sc.exam_date = v_s.exam_date and sc.session_label = v_s.session_label
     and not exists (select 1 from public.allocations a
                      where a.session_id = v_s.id and a.employee_id = sc.employee_id and a.released_at is null);
  select count(distinct employee_id) into v_flagged from public.employee_flags
   where session_id = v_s.id and status in ('pending', 'blocked');
  select count(*) into v_released from public.allocations where session_id = v_s.id and released_at is not null;

  select count(*) filter (where x.usable),
         count(*) filter (where x.usable and x.cnt >= x.cap),
         coalesce(sum(x.cap) filter (where x.usable), 0),
         coalesce(sum(greatest(x.cap - x.cnt, 0)) filter (where x.usable), 0)
    into v_act_rooms, v_full, v_slots, v_avail
    from (select (sr.is_active and r.is_active) as usable, sr.max_invigilators as cap,
                 (select count(*) from public.allocations a where a.session_room_id = sr.id and a.released_at is null) as cnt
            from public.session_rooms sr join public.rooms r on r.id = sr.room_id
           where sr.session_id = v_s.id) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'allocation_id', t.id, 'employee_id', t.employee_id, 'employee_name', t.employee_name,
           'room_code', t.room_code, 'round', t.round, 'source', t.source,
           'allocated_at', t.allocated_at, 'released_at', t.released_at) order by t.seq desc), '[]'::jsonb)
    into v_recent
    from (select a.id, a.seq, a.employee_id, sch.employee_name, r.room_code, a.round, a.source, a.allocated_at, a.released_at
            from public.allocations a
            join public.session_rooms sr on sr.id = a.session_room_id
            join public.rooms r on r.id = sr.room_id
            left join public.schedule sch on sch.employee_id = a.employee_id
                                         and sch.exam_date = v_s.exam_date and sch.session_label = v_s.session_label
           where a.session_id = v_s.id
           order by a.seq desc limit 15) t;

  return jsonb_build_object(
    'server_time', v_now,
    'state', v_state,
    'session', eoms_private.session_json(v_s)
               || jsonb_build_object('checkin_opens_at', v_s.checkin_opens_at, 'checkin_closes_at', v_s.checkin_closes_at),
    'counts', jsonb_build_object(
      'scheduled', v_scheduled, 'allocated', v_alloc, 'pending', v_pending, 'flagged', v_flagged,
      'released', v_released, 'active_rooms', v_act_rooms, 'full_rooms', v_full,
      'total_slots', v_slots, 'available_slots', v_avail),
    'recent', v_recent);
end;
$$;

create or replace function public.admin_room_monitor(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform eoms_private.require_admin();
  if p_session_id is null then
    raise exception 'session is required' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(m) order by m.room_code)
      from (
        select sr.id as session_room_id, r.id as room_id, r.room_code, r.building, r.floor,
               sr.max_invigilators as capacity, x.cnt as allocated, greatest(sr.max_invigilators - x.cnt, 0) as available,
               sr.is_active as link_active, r.is_active as room_active,
               case when not (sr.is_active and r.is_active) then 'inactive'
                    when x.cnt >= sr.max_invigilators then 'full' else 'available' end as status
          from public.session_rooms sr
          join public.rooms r on r.id = sr.room_id
          cross join lateral (select count(*)::int as cnt from public.allocations a
                               where a.session_room_id = sr.id and a.released_at is null) x
         where sr.session_id = p_session_id
      ) m), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lists
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_sessions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform eoms_private.require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.exam_date desc, x.session_label, x.checkin_opens_at)
      from (
        select s.id, s.exam_date, s.session_label, s.is_active, s.checkin_opens_at, s.checkin_closes_at,
               eoms_private.ist_text(s.checkin_opens_at) as opens_ist, eoms_private.ist_text(s.checkin_closes_at) as closes_ist,
               (select count(*) from public.schedule sc where sc.exam_date = s.exam_date and sc.session_label = s.session_label)::int as scheduled,
               (select count(*) from public.allocations a where a.session_id = s.id and a.released_at is null)::int as allocated,
               (select count(*) from public.session_rooms sr where sr.session_id = s.id)::int as room_links,
               (select coalesce(sum(sr.max_invigilators), 0) from public.session_rooms sr join public.rooms r on r.id = sr.room_id
                 where sr.session_id = s.id and sr.is_active and r.is_active)::int as total_slots,
               case when not s.is_active then 'INACTIVE'
                    when now() < s.checkin_opens_at then 'UPCOMING'
                    when now() >= s.checkin_closes_at then 'CLOSED' else 'OPEN' end as state
          from public.exam_sessions s) x), '[]'::jsonb);
end;
$$;

create or replace function public.admin_list_rooms()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform eoms_private.require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.room_code)
      from (
        select r.id, r.room_code, r.building, r.floor, r.is_active,
               (select count(*) from public.session_rooms sr where sr.room_id = r.id)::int as session_links,
               (select count(*) from public.allocations a join public.session_rooms sr on sr.id = a.session_room_id
                 where sr.room_id = r.id and a.released_at is null)::int as active_allocations
          from public.rooms r) x), '[]'::jsonb);
end;
$$;

create or replace function public.admin_list_schedule(
  p_session_id uuid default null, p_search text default null, p_status text default null,
  p_limit integer default 25, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pat text := eoms_private.like_pattern(p_search);
  v_lim integer := eoms_private.page_limit(p_limit);
  v_off integer := eoms_private.page_offset(p_offset);
  v_total integer;
  v_rows jsonb;
begin
  perform eoms_private.require_admin();
  if p_status is not null and p_status not in ('allocated', 'released', 'flagged', 'pending') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  select count(*) into v_total
    from eoms_private.schedule_state(p_session_id) t
   where (p_status is null or t.state = p_status)
     and (v_pat is null or t.employee_id ilike v_pat escape '\' or t.employee_name ilike v_pat escape '\'
          or t.department ilike v_pat escape '\');
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_rows
    from (
      select t.employee_id, t.employee_name, t.department, t.exam_date, t.session_label, t.state, t.room_code,
             t.import_batch_id, b.filename as import_filename
        from eoms_private.schedule_state(p_session_id) t
        left join public.import_batches b on b.id = t.import_batch_id
       where (p_status is null or t.state = p_status)
         and (v_pat is null or t.employee_id ilike v_pat escape '\' or t.employee_name ilike v_pat escape '\'
              or t.department ilike v_pat escape '\')
       order by t.exam_date, t.session_label, t.employee_id
       limit v_lim offset v_off) x;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create or replace function public.admin_list_allocations(
  p_session_id uuid default null, p_session_room_id uuid default null, p_search text default null,
  p_state text default 'active', p_limit integer default 25, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pat text := eoms_private.like_pattern(p_search);
  v_lim integer := eoms_private.page_limit(p_limit);
  v_off integer := eoms_private.page_offset(p_offset);
  v_total integer;
  v_rows jsonb;
begin
  perform eoms_private.require_admin();
  if p_state not in ('active', 'released', 'all') then
    raise exception 'state must be active, released or all' using errcode = '22023';
  end if;
  select count(*) into v_total
    from public.allocations a
    join public.exam_sessions es on es.id = a.session_id
    left join public.schedule sch on sch.employee_id = a.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
   where (p_session_id is null or a.session_id = p_session_id)
     and (p_session_room_id is null or a.session_room_id = p_session_room_id)
     and (p_state = 'all' or (p_state = 'active' and a.released_at is null) or (p_state = 'released' and a.released_at is not null))
     and (v_pat is null or a.employee_id ilike v_pat escape '\' or sch.employee_name ilike v_pat escape '\');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.seq desc), '[]'::jsonb) into v_rows
    from (
      select a.id, a.seq, a.session_id, es.exam_date, es.session_label, a.employee_id, sch.employee_name, sch.department,
             a.session_room_id, r.room_code, r.building, r.floor, a.round, a.source, a.allocated_at,
             a.released_at, a.release_reason, a.supersedes_allocation_id
        from public.allocations a
        join public.exam_sessions es on es.id = a.session_id
        join public.session_rooms sr on sr.id = a.session_room_id
        join public.rooms r on r.id = sr.room_id
        left join public.schedule sch on sch.employee_id = a.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
       where (p_session_id is null or a.session_id = p_session_id)
         and (p_session_room_id is null or a.session_room_id = p_session_room_id)
         and (p_state = 'all' or (p_state = 'active' and a.released_at is null) or (p_state = 'released' and a.released_at is not null))
         and (v_pat is null or a.employee_id ilike v_pat escape '\' or sch.employee_name ilike v_pat escape '\')
       order by a.seq desc limit v_lim offset v_off) x;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- Every allocation row ever made for one employee in one session (current, released and corrected).
create or replace function public.admin_allocation_history(p_session_id uuid, p_employee_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_emp text := eoms_private.norm_id(p_employee_id);
begin
  perform eoms_private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'room_code', r.room_code, 'round', a.round, 'source', a.source,
             'allocated_at', a.allocated_at, 'released_at', a.released_at, 'release_reason', a.release_reason,
             'released_by', case when a.released_by is null then null else eoms_private.admin_name(a.released_by) end,
             'created_by', case when a.created_by is null then null else eoms_private.admin_name(a.created_by) end,
             'supersedes_allocation_id', a.supersedes_allocation_id) order by a.seq)
      from public.allocations a
      join public.session_rooms sr on sr.id = a.session_room_id
      join public.rooms r on r.id = sr.room_id
     where a.session_id = p_session_id and a.employee_id = v_emp), '[]'::jsonb);
end;
$$;

-- p_status: pending | blocked | cleared | open (pending+blocked)
create or replace function public.admin_list_flags(
  p_status text default 'open', p_session_id uuid default null, p_search text default null,
  p_limit integer default 25, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pat text := eoms_private.like_pattern(p_search);
  v_lim integer := eoms_private.page_limit(p_limit);
  v_off integer := eoms_private.page_offset(p_offset);
  v_total integer;
  v_rows jsonb;
begin
  perform eoms_private.require_admin();
  if p_status is not null and p_status not in ('pending', 'blocked', 'cleared', 'open') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  select count(*) into v_total
    from public.employee_flags f
    join public.exam_sessions es on es.id = f.session_id
    left join public.schedule sch on sch.employee_id = f.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
   where (p_session_id is null or f.session_id = p_session_id)
     and (p_status is null or f.status = p_status or (p_status = 'open' and f.status in ('pending', 'blocked')))
     and (v_pat is null or f.employee_id ilike v_pat escape '\' or sch.employee_name ilike v_pat escape '\');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_rows
    from (
      select f.id, f.session_id, es.exam_date, es.session_label, f.employee_id, sch.employee_name, sch.department,
             f.reason, f.status, f.created_at, eoms_private.admin_name(f.created_by) as created_by_name,
             f.resolved_at, case when f.resolved_by is null then null else eoms_private.admin_name(f.resolved_by) end as resolved_by_name,
             f.resolution_note, upper(substr(f.id::text, 1, 8)) as reference
        from public.employee_flags f
        join public.exam_sessions es on es.id = f.session_id
        left join public.schedule sch on sch.employee_id = f.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
       where (p_session_id is null or f.session_id = p_session_id)
         and (p_status is null or f.status = p_status or (p_status = 'open' and f.status in ('pending', 'blocked')))
         and (v_pat is null or f.employee_id ilike v_pat escape '\' or sch.employee_name ilike v_pat escape '\')
       order by f.created_at desc limit v_lim offset v_off) x;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

-- p_status: open | consumed | revoked | expired ; p_kind: late | reentry
create or replace function public.admin_list_authorizations(
  p_session_id uuid default null, p_kind text default null, p_status text default null, p_search text default null,
  p_limit integer default 25, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pat text := eoms_private.like_pattern(p_search);
  v_lim integer := eoms_private.page_limit(p_limit);
  v_off integer := eoms_private.page_offset(p_offset);
  v_total integer;
  v_rows jsonb;
begin
  perform eoms_private.require_admin();
  if p_kind is not null and p_kind not in ('late', 'reentry') then
    raise exception 'unknown kind filter' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('open', 'consumed', 'revoked', 'expired') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  with x as (
    select a.id, a.kind, a.session_id, es.exam_date, es.session_label, a.employee_id, sch.employee_name, a.reason,
           eoms_private.admin_name(a.authorized_by) as authorized_by_name, a.authorized_at, a.expires_at,
           a.consumed_at, a.revoked_at,
           case when a.consumed_at is not null then 'consumed'
                when a.revoked_at is not null then 'revoked'
                when a.expires_at is not null and a.expires_at <= now() then 'expired'
                else 'open' end as status
      from public.admin_authorizations a
      join public.exam_sessions es on es.id = a.session_id
      left join public.schedule sch on sch.employee_id = a.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
     where (p_session_id is null or a.session_id = p_session_id)
       and (p_kind is null or a.kind = p_kind)
       and (v_pat is null or a.employee_id ilike v_pat escape '\' or sch.employee_name ilike v_pat escape '\')
  )
  select (select count(*) from x where p_status is null or x.status = p_status),
         coalesce((select jsonb_agg(to_jsonb(y) order by y.authorized_at desc)
                     from (select * from x where p_status is null or x.status = p_status
                            order by authorized_at desc limit v_lim offset v_off) y), '[]'::jsonb)
    into v_total, v_rows;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create or replace function public.admin_list_audit(
  p_search text default null, p_action text default null, p_from timestamptz default null,
  p_to timestamptz default null, p_limit integer default 25, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pat text := eoms_private.like_pattern(p_search);
  v_lim integer := eoms_private.page_limit(p_limit);
  v_off integer := eoms_private.page_offset(p_offset);
  v_total integer;
  v_rows jsonb;
begin
  perform eoms_private.require_admin();
  select count(*) into v_total
    from public.audit_log l
   where (p_action is null or l.action = p_action)
     and (p_from is null or l.at >= p_from) and (p_to is null or l.at < p_to)
     and (v_pat is null or l.actor ilike v_pat escape '\' or l.action ilike v_pat escape '\'
          or coalesce(l.entity_id, '') ilike v_pat escape '\' or coalesce(l.request_id, '') ilike v_pat escape '\'
          or coalesce(l.before::text, '') ilike v_pat escape '\' or coalesce(l.after::text, '') ilike v_pat escape '\');
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc), '[]'::jsonb) into v_rows
    from (
      select l.id, l.at, l.actor, case when l.actor_user_id is null then null else eoms_private.admin_name(l.actor_user_id) end as admin_name,
             l.action, l.entity, l.entity_id, l.before, l.after, l.request_id
        from public.audit_log l
       where (p_action is null or l.action = p_action)
         and (p_from is null or l.at >= p_from) and (p_to is null or l.at < p_to)
         and (v_pat is null or l.actor ilike v_pat escape '\' or l.action ilike v_pat escape '\'
              or coalesce(l.entity_id, '') ilike v_pat escape '\' or coalesce(l.request_id, '') ilike v_pat escape '\'
              or coalesce(l.before::text, '') ilike v_pat escape '\' or coalesce(l.after::text, '') ilike v_pat escape '\')
       order by l.id desc limit v_lim offset v_off) x;
  return jsonb_build_object('total', v_total, 'rows', v_rows,
    'actions', coalesce((select jsonb_agg(distinct action order by action) from public.audit_log), '[]'::jsonb));
end;
$$;

create or replace function public.admin_list_imports(p_limit integer default 25, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim integer := eoms_private.page_limit(p_limit);
  v_off integer := eoms_private.page_offset(p_offset);
begin
  perform eoms_private.require_admin();
  return jsonb_build_object(
    'total', (select count(*) from public.import_batches),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.uploaded_at desc)
        from (select b.id, b.filename, b.status, b.uploaded_at, eoms_private.admin_name(b.uploaded_by) as uploaded_by_name,
                     b.committed_at, b.row_count, b.valid_count, b.invalid_count,
                     b.duplicate_in_batch_count + b.exact_duplicate_count as duplicate_count, b.conflict_count,
                     b.inserted_count, b.replaced_count, b.error
                from public.import_batches b order by b.uploaded_at desc limit v_lim offset v_off) x), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports (columns are returned in display order; rows are objects keyed by column)
-- ---------------------------------------------------------------------------
create or replace function public.admin_report(
  p_report text, p_session_id uuid default null, p_from timestamptz default null,
  p_to timestamptz default null, p_limit integer default 500, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lim  integer := eoms_private.page_limit(p_limit, 1000);
  v_off  integer := eoms_private.page_offset(p_offset);
  v_cols jsonb;
  v_total integer;
  v_rows jsonb;
begin
  perform eoms_private.require_admin();

  if p_report = 'session_allocations' then
    v_cols := '["exam_date","session","employee_id","employee_name","department","room_code","building","floor","round","source","allocated_at_ist"]';
    select count(*) into v_total from public.allocations a
     where a.released_at is null and (p_session_id is null or a.session_id = p_session_id);
    select coalesce(jsonb_agg(to_jsonb(x) order by x.exam_date, x.session, x.room_code, x.seq), '[]') into v_rows
      from (select es.exam_date, es.session_label as session, a.employee_id, sch.employee_name, sch.department, r.room_code,
                   r.building, r.floor, a.round, a.source, eoms_private.ist_ts(a.allocated_at) as allocated_at_ist, a.seq
              from public.allocations a
              join public.exam_sessions es on es.id = a.session_id
              join public.session_rooms sr on sr.id = a.session_room_id join public.rooms r on r.id = sr.room_id
              left join public.schedule sch on sch.employee_id = a.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
             where a.released_at is null and (p_session_id is null or a.session_id = p_session_id)
             order by es.exam_date, es.session_label, r.room_code, a.seq limit v_lim offset v_off) x;

  elsif p_report = 'room_allocations' or p_report = 'full_rooms' then
    v_cols := '["exam_date","session","room_code","building","floor","capacity","allocated","available","status"]';
    select count(*) into v_total
      from public.session_rooms sr join public.rooms r on r.id = sr.room_id
      cross join lateral (select count(*)::int c from public.allocations a where a.session_room_id = sr.id and a.released_at is null) x
     where (p_session_id is null or sr.session_id = p_session_id)
       and (p_report = 'room_allocations' or (sr.is_active and r.is_active and x.c >= sr.max_invigilators));
    select coalesce(jsonb_agg(to_jsonb(y) order by y.exam_date, y.session, y.room_code), '[]') into v_rows
      from (select es.exam_date, es.session_label as session, r.room_code, r.building, r.floor, sr.max_invigilators as capacity,
                   x.c as allocated, greatest(sr.max_invigilators - x.c, 0) as available,
                   case when not (sr.is_active and r.is_active) then 'inactive' when x.c >= sr.max_invigilators then 'full' else 'available' end as status
              from public.session_rooms sr join public.rooms r on r.id = sr.room_id
              join public.exam_sessions es on es.id = sr.session_id
              cross join lateral (select count(*)::int c from public.allocations a where a.session_room_id = sr.id and a.released_at is null) x
             where (p_session_id is null or sr.session_id = p_session_id)
               and (p_report = 'room_allocations' or (sr.is_active and r.is_active and x.c >= sr.max_invigilators))
             order by es.exam_date, es.session_label, r.room_code limit v_lim offset v_off) y;

  elsif p_report = 'employee_allocations' or p_report = 'unallocated' then
    v_cols := '["exam_date","session","employee_id","employee_name","department","status","room_code","allocated_at_ist"]';
    select count(*) into v_total from eoms_private.schedule_state(p_session_id) t
     where p_report = 'employee_allocations' or t.state <> 'allocated';
    select coalesce(jsonb_agg(to_jsonb(y) order by y.exam_date, y.session, y.employee_id), '[]') into v_rows
      from (select t.exam_date, t.session_label as session, t.employee_id, t.employee_name, t.department, t.state as status,
                   t.room_code, eoms_private.ist_ts(t.allocated_at) as allocated_at_ist
              from eoms_private.schedule_state(p_session_id) t
             where p_report = 'employee_allocations' or t.state <> 'allocated'
             order by t.exam_date, t.session_label, t.employee_id limit v_lim offset v_off) y;

  elsif p_report = 'late_checkins' then
    v_cols := '["exam_date","session","employee_id","employee_name","reason","authorized_by","authorized_at_ist","status","room_code","allocated_at_ist"]';
    select count(*) into v_total from public.admin_authorizations a
     where a.kind = 'late' and (p_session_id is null or a.session_id = p_session_id)
       and (p_from is null or a.authorized_at >= p_from) and (p_to is null or a.authorized_at < p_to);
    select coalesce(jsonb_agg(to_jsonb(y) order by y.authorized_at_ist), '[]') into v_rows
      from (select es.exam_date, es.session_label as session, a.employee_id, sch.employee_name, a.reason,
                   eoms_private.admin_name(a.authorized_by) as authorized_by, eoms_private.ist_ts(a.authorized_at) as authorized_at_ist,
                   case when a.consumed_at is not null then 'used' when a.revoked_at is not null then 'revoked'
                        when a.expires_at is not null and a.expires_at <= now() then 'expired' else 'open' end as status,
                   r.room_code, eoms_private.ist_ts(al.allocated_at) as allocated_at_ist
              from public.admin_authorizations a
              join public.exam_sessions es on es.id = a.session_id
              left join public.schedule sch on sch.employee_id = a.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
              left join public.allocations al on al.id = a.consumed_allocation_id
              left join public.session_rooms sr on sr.id = al.session_room_id left join public.rooms r on r.id = sr.room_id
             where a.kind = 'late' and (p_session_id is null or a.session_id = p_session_id)
               and (p_from is null or a.authorized_at >= p_from) and (p_to is null or a.authorized_at < p_to)
             order by a.authorized_at limit v_lim offset v_off) y;

  elsif p_report = 'verification_exceptions' then
    v_cols := '["exam_date","session","employee_id","employee_name","status","reason","created_by","created_at_ist","resolved_by","resolved_at_ist","resolution_note"]';
    select count(*) into v_total from public.employee_flags f
     where (p_session_id is null or f.session_id = p_session_id)
       and (p_from is null or f.created_at >= p_from) and (p_to is null or f.created_at < p_to);
    select coalesce(jsonb_agg(to_jsonb(y) order by y.created_at_ist), '[]') into v_rows
      from (select es.exam_date, es.session_label as session, f.employee_id, sch.employee_name, f.status, f.reason,
                   eoms_private.admin_name(f.created_by) as created_by, eoms_private.ist_ts(f.created_at) as created_at_ist,
                   case when f.resolved_by is null then null else eoms_private.admin_name(f.resolved_by) end as resolved_by,
                   eoms_private.ist_ts(f.resolved_at) as resolved_at_ist, f.resolution_note
              from public.employee_flags f join public.exam_sessions es on es.id = f.session_id
              left join public.schedule sch on sch.employee_id = f.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
             where (p_session_id is null or f.session_id = p_session_id)
               and (p_from is null or f.created_at >= p_from) and (p_to is null or f.created_at < p_to)
             order by f.created_at limit v_lim offset v_off) y;

  elsif p_report = 'corrections' then
    v_cols := '["exam_date","session","employee_id","employee_name","action","from_room","to_room","reason","by","at_ist"]';
    select count(*) into v_total from public.allocations a
     where a.released_at is not null and (p_session_id is null or a.session_id = p_session_id)
       and (p_from is null or a.released_at >= p_from) and (p_to is null or a.released_at < p_to);
    select coalesce(jsonb_agg(to_jsonb(y) order by y.at_ist), '[]') into v_rows
      from (select es.exam_date, es.session_label as session, a.employee_id, sch.employee_name,
                   case when n.id is not null then 'reassigned' else 'released' end as action,
                   r.room_code as from_room, nr.room_code as to_room, a.release_reason as reason,
                   case when a.released_by is null then null else eoms_private.admin_name(a.released_by) end as by,
                   eoms_private.ist_ts(a.released_at) as at_ist
              from public.allocations a
              join public.exam_sessions es on es.id = a.session_id
              join public.session_rooms sr on sr.id = a.session_room_id join public.rooms r on r.id = sr.room_id
              left join public.allocations n on n.supersedes_allocation_id = a.id
              left join public.session_rooms nsr on nsr.id = n.session_room_id left join public.rooms nr on nr.id = nsr.room_id
              left join public.schedule sch on sch.employee_id = a.employee_id and sch.exam_date = es.exam_date and sch.session_label = es.session_label
             where a.released_at is not null and (p_session_id is null or a.session_id = p_session_id)
               and (p_from is null or a.released_at >= p_from) and (p_to is null or a.released_at < p_to)
             order by a.released_at limit v_lim offset v_off) y;

  elsif p_report = 'imports' then
    v_cols := '["filename","status","uploaded_by","uploaded_at_ist","committed_at_ist","rows","valid","invalid","duplicates","conflicts","inserted","replaced"]';
    select count(*) into v_total from public.import_batches b
     where (p_from is null or b.uploaded_at >= p_from) and (p_to is null or b.uploaded_at < p_to);
    select coalesce(jsonb_agg(to_jsonb(y) order by y.uploaded_at_ist), '[]') into v_rows
      from (select b.filename, b.status, eoms_private.admin_name(b.uploaded_by) as uploaded_by,
                   eoms_private.ist_ts(b.uploaded_at) as uploaded_at_ist, eoms_private.ist_ts(b.committed_at) as committed_at_ist,
                   b.row_count as rows, b.valid_count as valid, b.invalid_count as invalid,
                   b.duplicate_in_batch_count + b.exact_duplicate_count as duplicates, b.conflict_count as conflicts,
                   b.inserted_count as inserted, b.replaced_count as replaced
              from public.import_batches b
             where (p_from is null or b.uploaded_at >= p_from) and (p_to is null or b.uploaded_at < p_to)
             order by b.uploaded_at limit v_lim offset v_off) y;

  else
    raise exception 'unknown report' using errcode = '22023';
  end if;

  return jsonb_build_object('report', p_report, 'columns', v_cols, 'rows', v_rows, 'total', v_total);
end;
$$;

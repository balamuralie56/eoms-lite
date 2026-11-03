-- EOMS Lite — 0002: allocation engine, public RPCs, admin RPCs.
--
-- Every function here is SECURITY DEFINER with SET search_path = '' and fully qualified
-- object names. No dynamic SQL. EXECUTE grants are set in 0003 (revoked from PUBLIC first).
--
-- Concurrency model (see docs/ALLOCATION_ALGORITHM.md):
--   one transaction-level advisory lock per exam session, taken BEFORE any read that decides an
--   allocation outcome, under READ COMMITTED. No SKIP LOCKED anywhere.

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

create or replace function eoms_private.request_ref()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v text;
begin
  begin
    v := nullif(current_setting('request.headers', true), '')::json ->> 'x-request-id';
  exception when others then
    v := null;
  end;
  return coalesce(v, gen_random_uuid()::text);
end;
$$;

-- sha256 hex of the client IP as forwarded by the platform, or null when unknown.
create or replace function eoms_private.client_ip_hash()
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_headers json;
  v_ip      text;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if v_headers is null then
    return null;
  end if;
  v_ip := btrim(split_part(coalesce(v_headers ->> 'cf-connecting-ip', v_headers ->> 'x-forwarded-for', ''), ',', 1));
  if v_ip = '' then
    return null;
  end if;
  return encode(sha256(convert_to(v_ip, 'UTF8')), 'hex');
end;
$$;

create or replace function eoms_private.audit(
  p_actor text, p_actor_user uuid, p_action text, p_entity text, p_entity_id text,
  p_before jsonb, p_after jsonb
)
returns void
language sql
set search_path = ''
as $$
  insert into public.audit_log (actor, actor_user_id, action, entity, entity_id, before, after, request_id)
  values (p_actor, p_actor_user, p_action, p_entity, p_entity_id, p_before, p_after, eoms_private.request_ref());
$$;

-- Returns the authenticated, ACTIVE admin's uuid or raises. Identity comes only from the JWT.
create or replace function eoms_private.require_admin()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null
     or not exists (select 1 from public.admins a where a.user_id = v_uid and a.is_active) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create or replace function eoms_private.norm_id(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select upper(btrim(coalesce(p, ''))) $$;

create or replace function eoms_private.require_reason(p text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or char_length(btrim(p)) < 3 then
    raise exception 'a reason of at least 3 characters is required' using errcode = '22023';
  end if;
  return btrim(p);
end;
$$;

-- JSON for an allocation, limited to what the employee needs for their slip.
create or replace function eoms_private.alloc_result(p_code text, p_alloc_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok',            true,
    'code',          p_code,
    'employee_id',   a.employee_id,
    'employee_name', sch.employee_name,
    'department',    sch.department,
    'exam_date',     s.exam_date,
    'session',       s.session_label,
    'room_code',     r.room_code,
    'building',      r.building,
    'floor',         r.floor,
    'round',         a.round,
    'allocated_at',  a.allocated_at,
    'reference',     upper(substr(a.id::text, 1, 8))
  )
  from public.allocations a
  join public.exam_sessions s on s.id = a.session_id
  join public.session_rooms sr on sr.id = a.session_room_id
  join public.rooms r on r.id = sr.room_id
  left join public.schedule sch
         on sch.employee_id = a.employee_id and sch.exam_date = s.exam_date and sch.session_label = s.session_label
  where a.id = p_alloc_id
$$;

create or replace function eoms_private.reject(p_code text, p_message text, p_extra jsonb default '{}'::jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'message', p_message) || p_extra
$$;

-- THE ALLOCATION POLICY. Caller MUST already hold the session lock.
--   1. eligible = active room in active session_room with active allocations < max_invigilators
--   2. m = min(active allocations) over eligible
--   3. pick uniformly at random among eligible rooms with count = m
-- When p_room is given (admin correction) policy selection is skipped, but the same
-- capacity / activity checks apply (via the insert trigger and the explicit check here).
-- Returns the new allocation id, or null when no room is eligible.
create or replace function eoms_private.allocate(
  p_session uuid, p_employee text, p_source text,
  p_room uuid default null, p_supersedes uuid default null, p_actor uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_room  uuid;
  v_count integer;
  v_id    uuid;
begin
  if p_room is not null then
    v_room := p_room;
  else
    with counts as (
      select sr.id,
             sr.max_invigilators,
             (select count(*) from public.allocations a
               where a.session_room_id = sr.id and a.released_at is null) as cnt
        from public.session_rooms sr
        join public.rooms r on r.id = sr.room_id
       where sr.session_id = p_session and sr.is_active and r.is_active
    ),
    eligible as (
      select id, cnt from counts where cnt < max_invigilators
    )
    select id into v_room
      from eligible
     where cnt = (select min(cnt) from eligible)
     order by random()
     limit 1;

    if v_room is null then
      return null;
    end if;
  end if;

  select count(*) into v_count
    from public.allocations where session_room_id = v_room and released_at is null;

  insert into public.allocations
    (session_id, session_room_id, employee_id, round, source, supersedes_allocation_id, created_by)
  values
    (p_session, v_room, p_employee, v_count + 1, p_source, p_supersedes, p_actor)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

create or replace function public.get_checkin_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_s   public.exam_sessions;
begin
  select * into v_s
    from public.exam_sessions
   where is_active and checkin_opens_at <= v_now and v_now < checkin_closes_at
   limit 1;                                     -- at most one: exclusion constraint

  if v_s.id is null then
    return jsonb_build_object('state', 'CLOSED', 'server_time', v_now);
  end if;
  return jsonb_build_object(
    'state', 'OPEN',
    'server_time', v_now,
    'exam_date', v_s.exam_date,
    'session', v_s.session_label,
    'checkin_closes_at', v_s.checkin_closes_at
  );
end;
$$;

create or replace function public.checkin(p_employee_id text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_now      timestamptz := now();   -- decision time = request start (fixed for the whole call)
  v_emp      text := eoms_private.norm_id(p_employee_id);
  v_ip       text := eoms_private.client_ip_hash();
  v_max_fail integer;
  v_win      integer;
  v_fails    integer;
  v_auth     public.admin_authorizations;
  v_session  public.exam_sessions;
  v_alloc    uuid;
  v_flag     public.employee_flags;
  v_released boolean;
  v_open     boolean;
  v_new      uuid;
begin
  perform eoms_private.assert_read_committed();

  -- 0. Format check (no data access). Failures are recorded for throttling.
  if v_emp !~ '^[A-Z0-9._/-]{1,50}$' then
    if v_ip is not null then
      insert into public.check_attempts (ip_hash, employee_id, outcome) values (v_ip, null, 'INVALID_ID');
    end if;
    return eoms_private.reject('INVALID_ID', 'Please enter a valid Employee ID.');
  end if;

  -- 1. Abuse throttle: too many FAILED lookups from this client IP recently.
  if v_ip is not null then
    select int_value into v_max_fail from public.app_settings where key = 'throttle_max_failures';
    select int_value into v_win      from public.app_settings where key = 'throttle_window_seconds';
    select count(*) into v_fails
      from public.check_attempts
     where ip_hash = v_ip and at > v_now - make_interval(secs => v_win);
    if v_fails >= v_max_fail then
      return eoms_private.reject('RATE_LIMITED', 'Too many unsuccessful attempts. Please wait a few minutes or contact the examination cell.');
    end if;
  end if;

  -- 2. Resolve the session (unlocked read; everything decision-relevant is re-read under the lock).
  --    a) an open admin permit for this employee, whose session has no active allocation yet, wins;
  --    b) otherwise the single currently open session; c) otherwise rejected. NEVER "most recent".
  select a.* into v_auth
    from public.admin_authorizations a
    join public.exam_sessions s on s.id = a.session_id and s.is_active
   where a.employee_id = v_emp
     and a.consumed_at is null and a.revoked_at is null
     and (a.expires_at is null or a.expires_at > v_now)
     and not exists (select 1 from public.allocations x
                      where x.session_id = a.session_id and x.employee_id = v_emp and x.released_at is null)
   order by a.authorized_at
   limit 1;

  if v_auth.id is not null then
    select * into v_session from public.exam_sessions where id = v_auth.session_id;
  else
    select * into v_session
      from public.exam_sessions
     where is_active and checkin_opens_at <= v_now and v_now < checkin_closes_at
     limit 1;
  end if;

  if v_session.id is null then
    return eoms_private.reject('NO_ACTIVE_SESSION',
      'Check-in is not currently open. If your session has ended, please contact the examination cell.');
  end if;

  -- 3. Schedule validation for the exact date + session (unlocked; static during an exam).
  if not exists (select 1 from public.schedule
                  where employee_id = v_emp and exam_date = v_session.exam_date
                    and session_label = v_session.session_label) then
    if v_ip is not null then
      insert into public.check_attempts (ip_hash, employee_id, outcome) values (v_ip, v_emp, 'NOT_SCHEDULED');
    end if;
    return eoms_private.reject('NOT_SCHEDULED',
      'No invigilation duty was found for this session. Please contact the examination cell.');
  end if;

  -- 4. SERIALISE per session. Bounded wait (lock_timeout) -> retryable BUSY, never a hang.
  begin
    perform eoms_private.lock_session(v_session.id);
  exception when lock_not_available then
    return eoms_private.reject('BUSY', 'The system is busy. Please try again in a moment.');
  end;

  -- 5. Idempotency: an active allocation is returned unchanged. Never re-randomised.
  select id into v_alloc
    from public.allocations
   where session_id = v_session.id and employee_id = v_emp and released_at is null;
  if v_alloc is not null then
    return eoms_private.alloc_result('ALREADY_ALLOCATED', v_alloc);
  end if;

  -- 6. Re-read session + permit under the lock (state may have changed while waiting).
  select * into v_session from public.exam_sessions where id = v_session.id;
  if not v_session.is_active then
    return eoms_private.reject('NO_ACTIVE_SESSION',
      'Check-in is not currently open. If your session has ended, please contact the examination cell.');
  end if;

  select a.* into v_auth
    from public.admin_authorizations a
   where a.session_id = v_session.id and a.employee_id = v_emp
     and a.consumed_at is null and a.revoked_at is null
     and (a.expires_at is null or a.expires_at > v_now);

  -- 7. Verification flag (pending or blocked) -> only an admin can clear it.
  select * into v_flag
    from public.employee_flags
   where session_id = v_session.id and employee_id = v_emp and status in ('pending', 'blocked')
   order by created_at desc
   limit 1;
  if v_flag.id is not null then
    return eoms_private.reject('VERIFICATION_REQUIRED',
      'Your check-in needs verification by the examination cell. Please contact the examination cell.',
      jsonb_build_object('reference', upper(substr(v_flag.id::text, 1, 8))));
  end if;

  -- 8. A previously released allocation is never silently recreated.
  select exists (select 1 from public.allocations
                  where session_id = v_session.id and employee_id = v_emp and released_at is not null)
    into v_released;
  if v_released and (v_auth.id is null or v_auth.kind <> 'reentry') then
    return eoms_private.reject('REENTRY_REQUIRES_ADMIN',
      'Your earlier allocation was released. Please contact the examination cell.');
  end if;

  -- 9. Window: must be inside the configured window unless an admin permit exists.
  v_open := v_session.checkin_opens_at <= v_now and v_now < v_session.checkin_closes_at;
  if not v_open and v_auth.id is null then
    return eoms_private.reject('NO_ACTIVE_SESSION',
      'Check-in is not currently open. If your session has ended, please contact the examination cell.');
  end if;

  -- 10. Allocate by policy. A permit does NOT bypass room activity or capacity.
  v_new := eoms_private.allocate(
    v_session.id, v_emp,
    case when v_auth.id is null then 'normal'
         when v_auth.kind = 'late' then 'admin_late'
         else 'admin_reentry' end,
    null, null, v_auth.authorized_by);

  if v_new is null then
    return eoms_private.reject('ROOMS_FULL',
      'All rooms are currently full. Please contact the examination cell.');
  end if;

  if v_auth.id is not null then
    update public.admin_authorizations
       set consumed_at = v_now, consumed_allocation_id = v_new
     where id = v_auth.id;
  end if;

  perform eoms_private.audit(
    'employee:' || v_emp, null, 'allocation.create', 'allocation', v_new::text, null,
    (select to_jsonb(a) from public.allocations a where a.id = v_new)
      || jsonb_build_object('authorization_id', v_auth.id));

  return eoms_private.alloc_result('ALLOCATED', v_new);
end;
$$;

-- For RLS policies / UI: is the caller an active admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid() and a.is_active)
$$;

-- ---------------------------------------------------------------------------
-- Admin RPCs (all verify the authenticated admin inside; client never supplies an admin id)
-- ---------------------------------------------------------------------------

create or replace function public.admin_authorize_late(
  p_employee_id text, p_session_id uuid, p_reason text, p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_emp    text := eoms_private.norm_id(p_employee_id);
  v_reason text := eoms_private.require_reason(p_reason);
  v_s      public.exam_sessions;
  v_id     uuid;
begin
  perform eoms_private.assert_read_committed();
  select * into v_s from public.exam_sessions where id = p_session_id;
  if v_s.id is null or not v_s.is_active then
    raise exception 'session not found or inactive' using errcode = '22023';
  end if;
  -- Schedule validation is NOT bypassed.
  if not exists (select 1 from public.schedule
                  where employee_id = v_emp and exam_date = v_s.exam_date and session_label = v_s.session_label) then
    raise exception 'employee % is not scheduled for this session', v_emp using errcode = '22023';
  end if;

  perform eoms_private.lock_session(p_session_id);

  if exists (select 1 from public.allocations
              where session_id = p_session_id and employee_id = v_emp and released_at is null) then
    raise exception 'employee already has an active allocation' using errcode = '23505';
  end if;
  if exists (select 1 from public.allocations
              where session_id = p_session_id and employee_id = v_emp and released_at is not null) then
    raise exception 'allocation was released earlier: use admin_authorize_reentry' using errcode = '22023';
  end if;

  insert into public.admin_authorizations (kind, session_id, employee_id, reason, authorized_by, expires_at)
  values ('late', p_session_id, v_emp, v_reason, v_admin, p_expires_at)
  returning id into v_id;

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'authorization.late', 'admin_authorization', v_id::text, null,
    jsonb_build_object('employee_id', v_emp, 'session_id', p_session_id, 'reason', v_reason, 'expires_at', p_expires_at));
  return jsonb_build_object('ok', true, 'authorization_id', v_id);
end;
$$;

create or replace function public.admin_authorize_reentry(
  p_employee_id text, p_session_id uuid, p_reason text, p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_emp    text := eoms_private.norm_id(p_employee_id);
  v_reason text := eoms_private.require_reason(p_reason);
  v_s      public.exam_sessions;
  v_id     uuid;
begin
  perform eoms_private.assert_read_committed();
  select * into v_s from public.exam_sessions where id = p_session_id;
  if v_s.id is null or not v_s.is_active then
    raise exception 'session not found or inactive' using errcode = '22023';
  end if;
  if not exists (select 1 from public.schedule
                  where employee_id = v_emp and exam_date = v_s.exam_date and session_label = v_s.session_label) then
    raise exception 'employee % is not scheduled for this session', v_emp using errcode = '22023';
  end if;

  perform eoms_private.lock_session(p_session_id);

  if exists (select 1 from public.allocations
              where session_id = p_session_id and employee_id = v_emp and released_at is null) then
    raise exception 'employee already has an active allocation' using errcode = '23505';
  end if;
  if not exists (select 1 from public.allocations
                  where session_id = p_session_id and employee_id = v_emp and released_at is not null) then
    raise exception 'no released allocation exists for this employee and session' using errcode = '22023';
  end if;

  insert into public.admin_authorizations (kind, session_id, employee_id, reason, authorized_by, expires_at)
  values ('reentry', p_session_id, v_emp, v_reason, v_admin, p_expires_at)
  returning id into v_id;

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'authorization.reentry', 'admin_authorization', v_id::text, null,
    jsonb_build_object('employee_id', v_emp, 'session_id', p_session_id, 'reason', v_reason, 'expires_at', p_expires_at));
  return jsonb_build_object('ok', true, 'authorization_id', v_id);
end;
$$;

create or replace function public.admin_revoke_authorization(p_authorization_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_reason text := eoms_private.require_reason(p_reason);
  v_a      public.admin_authorizations;
begin
  select * into v_a from public.admin_authorizations where id = p_authorization_id;
  if v_a.id is null then
    raise exception 'authorization not found' using errcode = '22023';
  end if;
  perform eoms_private.lock_session(v_a.session_id);
  update public.admin_authorizations
     set revoked_at = now(), revoked_by = v_admin
   where id = p_authorization_id and consumed_at is null and revoked_at is null;
  if not found then
    raise exception 'authorization already consumed or revoked' using errcode = '22023';
  end if;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'authorization.revoke', 'admin_authorization',
    p_authorization_id::text, to_jsonb(v_a), jsonb_build_object('reason', v_reason));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.admin_release(p_allocation_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_reason text := eoms_private.require_reason(p_reason);
  v_a      public.allocations;
  v_after  public.allocations;
begin
  perform eoms_private.assert_read_committed();
  select * into v_a from public.allocations where id = p_allocation_id;
  if v_a.id is null then
    raise exception 'allocation not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(v_a.session_id);          -- same lock as employee allocation

  select * into v_a from public.allocations where id = p_allocation_id;   -- re-read under lock
  if v_a.released_at is not null then
    raise exception 'allocation already released' using errcode = '22023';
  end if;

  update public.allocations
     set released_at = now(), released_by = v_admin, release_reason = v_reason
   where id = p_allocation_id
   returning * into v_after;

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'allocation.release', 'allocation', p_allocation_id::text,
    to_jsonb(v_a), to_jsonb(v_after));
  return jsonb_build_object('ok', true, 'allocation_id', p_allocation_id);
end;
$$;

create or replace function public.admin_reassign(
  p_allocation_id uuid, p_new_session_room_id uuid, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin   uuid := eoms_private.require_admin();
  v_reason  text := eoms_private.require_reason(p_reason);
  v_old     public.allocations;
  v_old_rel public.allocations;
  v_target  record;
  v_count   integer;
  v_new     uuid;
begin
  perform eoms_private.assert_read_committed();
  select * into v_old from public.allocations where id = p_allocation_id;
  if v_old.id is null then
    raise exception 'allocation not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(v_old.session_id);

  select * into v_old from public.allocations where id = p_allocation_id;   -- re-read under lock
  if v_old.released_at is not null then
    raise exception 'allocation already released' using errcode = '22023';
  end if;
  if v_old.session_room_id = p_new_session_room_id then
    raise exception 'allocation is already in that room' using errcode = '22023';
  end if;

  select sr.id, sr.session_id, sr.max_invigilators, (sr.is_active and r.is_active) as usable
    into v_target
    from public.session_rooms sr join public.rooms r on r.id = sr.room_id
   where sr.id = p_new_session_room_id;
  if v_target.id is null or v_target.session_id <> v_old.session_id then
    raise exception 'target room is not configured for this session' using errcode = '22023';
  end if;
  if not v_target.usable then
    raise exception 'target room is inactive' using errcode = '22023';
  end if;
  select count(*) into v_count
    from public.allocations where session_room_id = p_new_session_room_id and released_at is null;
  if v_count >= v_target.max_invigilators then
    raise exception 'target room is full' using errcode = '23514';
  end if;

  update public.allocations
     set released_at = now(), released_by = v_admin, release_reason = 'reassigned: ' || v_reason
   where id = p_allocation_id
   returning * into v_old_rel;

  v_new := eoms_private.allocate(v_old.session_id, v_old.employee_id, 'admin_correction',
                                 p_new_session_room_id, p_allocation_id, v_admin);

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'allocation.reassign', 'allocation', p_allocation_id::text,
    to_jsonb(v_old),
    jsonb_build_object('reason', v_reason, 'released', to_jsonb(v_old_rel),
                       'new_allocation', (select to_jsonb(a) from public.allocations a where a.id = v_new)));
  return jsonb_build_object('ok', true, 'old_allocation_id', p_allocation_id, 'new_allocation_id', v_new);
end;
$$;

create or replace function public.admin_flag_employee(p_employee_id text, p_session_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_emp    text := eoms_private.norm_id(p_employee_id);
  v_reason text := eoms_private.require_reason(p_reason);
  v_id     uuid;
begin
  if not exists (select 1 from public.exam_sessions where id = p_session_id) then
    raise exception 'session not found' using errcode = '22023';
  end if;
  if v_emp = '' then
    raise exception 'employee id required' using errcode = '22023';
  end if;
  perform eoms_private.lock_session(p_session_id);
  insert into public.employee_flags (session_id, employee_id, reason, created_by)
  values (p_session_id, v_emp, v_reason, v_admin)
  returning id into v_id;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'flag.create', 'employee_flag', v_id::text, null,
    jsonb_build_object('employee_id', v_emp, 'session_id', p_session_id, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'flag_id', v_id, 'reference', upper(substr(v_id::text, 1, 8)));
end;
$$;

create or replace function public.admin_resolve_flag(p_flag_id uuid, p_decision text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin uuid := eoms_private.require_admin();
  v_note  text := eoms_private.require_reason(p_note);
  v_f     public.employee_flags;
  v_after public.employee_flags;
begin
  if p_decision not in ('cleared', 'blocked') then
    raise exception 'decision must be cleared or blocked' using errcode = '22023';
  end if;
  select * into v_f from public.employee_flags where id = p_flag_id;
  if v_f.id is null then
    raise exception 'flag not found' using errcode = '22023';
  end if;
  perform eoms_private.lock_session(v_f.session_id);
  select * into v_f from public.employee_flags where id = p_flag_id;
  if v_f.status = 'cleared' then
    raise exception 'flag already cleared' using errcode = '22023';
  end if;
  update public.employee_flags
     set status = p_decision, resolved_by = v_admin, resolved_at = now(), resolution_note = v_note
   where id = p_flag_id
   returning * into v_after;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'flag.resolve', 'employee_flag', p_flag_id::text,
    to_jsonb(v_f), to_jsonb(v_after));
  return jsonb_build_object('ok', true, 'status', p_decision);
end;
$$;

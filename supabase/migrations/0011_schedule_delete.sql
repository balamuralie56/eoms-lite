-- EOMS Lite — 0011: audited admin RPCs for schedule deletion.
-- Pattern: SECURITY DEFINER, SET search_path = '', require_admin(), per-session advisory lock, audit row.

-- ---------------------------------------------------------------------------
-- admin_delete_schedule_entry: delete a single row (only when no active allocation or pending flag)
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_schedule_entry(
  p_employee_id   text,
  p_exam_date     date,
  p_session_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin     uuid := eoms_private.require_admin();
  v_norm_id   text := upper(btrim(coalesce(p_employee_id, '')));
  v_norm_sess text := upper(btrim(coalesce(p_session_label, '')));
  v_session   public.exam_sessions;
  v_before    jsonb;
begin
  perform eoms_private.assert_read_committed();

  if v_norm_id = '' then
    raise exception 'employee ID is required' using errcode = '22023';
  end if;
  if v_norm_sess not in ('FN', 'AN') then
    raise exception 'session must be FN or AN' using errcode = '22023';
  end if;

  select * into v_session from public.exam_sessions
   where exam_date = p_exam_date and session_label = v_norm_sess;
  if v_session.id is null then
    raise exception 'no examination session configured for % %', p_exam_date, v_norm_sess
      using errcode = '22023';
  end if;

  -- Serialise against the check-in engine and other admin ops on this session
  perform eoms_private.lock_session(v_session.id);

  if exists (
    select 1 from public.allocations
     where session_id = v_session.id and employee_id = v_norm_id and released_at is null
  ) then
    raise exception 'employee has an active allocation — release it first' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.employee_flags
     where session_id = v_session.id and employee_id = v_norm_id and status in ('pending', 'blocked')
  ) then
    raise exception 'employee has an unresolved verification flag — resolve it first' using errcode = '23514';
  end if;

  select to_jsonb(s) into v_before
    from public.schedule s
   where s.employee_id = v_norm_id and s.exam_date = p_exam_date and s.session_label = v_norm_sess;

  if v_before is null then
    raise exception 'schedule entry not found' using errcode = '22023';
  end if;

  delete from public.schedule
   where employee_id = v_norm_id and exam_date = p_exam_date and session_label = v_norm_sess;

  perform eoms_private.audit(
    'admin:' || v_admin, v_admin,
    'schedule.delete_entry', 'schedule',
    v_norm_id || '|' || p_exam_date || '|' || v_norm_sess,
    v_before, null
  );

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_clear_session_schedule: delete all safe rows for a session in one go.
--   p_confirm = false  → dry run: returns {ok, would_delete, would_skip}
--   p_confirm = true   → executes:  returns {ok, deleted, skipped}
-- Rows with an active (unreleased) allocation or a pending/blocked flag are always skipped.
-- ---------------------------------------------------------------------------
create or replace function public.admin_clear_session_schedule(
  p_session_id uuid,
  p_confirm    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin   uuid := eoms_private.require_admin();
  v_session public.exam_sessions;
  v_safe    integer := 0;
  v_skipped integer := 0;
  v_deleted integer := 0;
begin
  perform eoms_private.assert_read_committed();

  select * into v_session from public.exam_sessions where id = p_session_id;
  if v_session.id is null then
    raise exception 'session not found' using errcode = '22023';
  end if;

  perform eoms_private.lock_session(v_session.id);

  select
    count(*) filter (where not has_active and not has_flag),
    count(*) filter (where has_active or has_flag)
  into v_safe, v_skipped
  from (
    select
      exists (select 1 from public.allocations a
               where a.session_id = v_session.id and a.employee_id = s.employee_id and a.released_at is null) as has_active,
      exists (select 1 from public.employee_flags f
               where f.session_id = v_session.id and f.employee_id = s.employee_id and f.status in ('pending', 'blocked')) as has_flag
      from public.schedule s
     where s.exam_date = v_session.exam_date and s.session_label = v_session.session_label
  ) x;

  if not coalesce(p_confirm, false) then
    return jsonb_build_object('ok', true, 'would_delete', v_safe, 'would_skip', v_skipped);
  end if;

  with removed as (
    delete from public.schedule
     where exam_date = v_session.exam_date and session_label = v_session.session_label
       and not exists (select 1 from public.allocations a
                        where a.session_id = v_session.id and a.employee_id = schedule.employee_id
                          and a.released_at is null)
       and not exists (select 1 from public.employee_flags f
                        where f.session_id = v_session.id and f.employee_id = schedule.employee_id
                          and f.status in ('pending', 'blocked'))
     returning employee_id
  )
  select count(*) into v_deleted from removed;

  perform eoms_private.audit(
    'admin:' || v_admin, v_admin,
    'schedule.clear_session', 'exam_session', v_session.id::text,
    jsonb_build_object('exam_date', v_session.exam_date, 'session', v_session.session_label),
    jsonb_build_object('deleted', v_deleted, 'skipped', v_skipped)
  );

  return jsonb_build_object('ok', true, 'deleted', v_deleted, 'skipped', v_skipped);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (same pattern as 0007 / 0010)
-- ---------------------------------------------------------------------------
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('admin_delete_schedule_entry', 'admin_clear_session_schedule')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

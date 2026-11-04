-- EOMS Lite — 0014: fix admin_reset_all_data delete order. 0013 fixed the "requires a WHERE clause" error;
-- this fixes a real foreign-key ordering bug it then exposed: admin_authorizations.consumed_allocation_id
-- references allocations(id), but allocations was being deleted BEFORE admin_authorizations, which always
-- fails ("... violates foreign key constraint admin_authorizations_consumed_allocation_id_fkey").
--
-- Deletes now run in dependency order (children before parents), and allocations' own self-reference
-- (supersedes_allocation_id -> allocations.id) is nulled out first so a bulk single-table delete can
-- never trip over it regardless of internal row-processing order.

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

  -- Break the self-reference first so the bulk allocations delete below never trips over it.
  update public.allocations set supersedes_allocation_id = null where supersedes_allocation_id is not null;

  delete from public.import_rows where true;            -- references import_batches
  delete from public.admin_authorizations where true;    -- references exam_sessions, allocations
  delete from public.allocations where true;              -- references exam_sessions, session_rooms
  delete from public.employee_flags where true;           -- references exam_sessions
  delete from public.schedule where true;                 -- references import_batches
  delete from public.import_batches where true;           -- no longer referenced
  delete from public.session_rooms where true;            -- references exam_sessions, rooms
  delete from public.exam_sessions where true;             -- no longer referenced
  delete from public.rooms where true;                     -- no longer referenced
  delete from public.check_attempts where true;            -- no foreign keys
  delete from public.audit_log where true;

  execute 'alter table public.allocations enable trigger allocations_no_delete';
  execute 'alter table public.allocations enable trigger allocations_no_truncate';
  execute 'alter table public.audit_log enable trigger audit_log_no_update_delete';
  execute 'alter table public.audit_log enable trigger audit_log_no_truncate';

  insert into public.audit_log (actor, actor_user_id, action, entity, entity_id, before, after)
  values ('admin:' || v_admin, v_admin, 'system.full_reset', 'database', null, v_counts, jsonb_build_object('ok', true));

  return jsonb_build_object('ok', true, 'dry_run', false, 'deleted', v_counts);
end;
$$;

-- EOMS Lite — 0007 (Phase 2A): RLS and privileges for the Phase 2A objects. Same default-deny model as 0003.

-- New table: default deny, admin read-only through RLS.
revoke all on public.import_rows from public, anon, authenticated;
alter table public.import_rows enable row level security;
grant select on public.import_rows to authenticated;
create policy import_rows_admin_read on public.import_rows for select to authenticated using (public.is_admin());

-- Everything new in eoms_private stays uncallable by API roles.
revoke all on all functions in schema eoms_private from public, anon, authenticated;

-- Admin RPCs: explicit REVOKE first, then GRANT to authenticated only. Each function re-verifies the
-- ACTIVE admin from auth.uid() inside. anon can call none of them.
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'admin_create_session', 'admin_update_session', 'admin_set_session_active',
       'admin_create_room', 'admin_update_room', 'admin_set_room_active',
       'admin_assign_room_to_session', 'admin_update_session_room',
       'admin_set_session_room_active', 'admin_remove_session_room',
       'admin_import_begin', 'admin_import_add_rows', 'admin_import_validate', 'admin_import_preview',
       'admin_import_cancel', 'admin_import_commit', 'admin_import_replace_conflicts')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

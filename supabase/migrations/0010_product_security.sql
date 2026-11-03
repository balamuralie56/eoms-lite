-- EOMS Lite — 0010 (product phase): RLS and privileges for 0008/0009 objects. Same default-deny model as 0003/0007.

revoke all on public.app_branding from public, anon, authenticated;
alter table public.app_branding enable row level security;
grant select on public.app_branding to authenticated;
create policy app_branding_admin_read on public.app_branding for select to authenticated using (public.is_admin());

revoke all on all functions in schema eoms_private from public, anon, authenticated;

do $$
declare
  f regprocedure;
begin
  -- admin-only RPCs: authenticated may execute, each re-verifies the ACTIVE admin inside
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'admin_get_settings', 'admin_update_settings', 'admin_run_maintenance', 'admin_debug_request_headers',
       'admin_overview', 'admin_room_monitor', 'admin_list_sessions', 'admin_list_rooms', 'admin_list_schedule',
       'admin_list_allocations', 'admin_allocation_history', 'admin_list_flags', 'admin_list_authorizations',
       'admin_list_audit', 'admin_list_imports', 'admin_report')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;

-- the only new anonymous surface: public branding
revoke all on function public.get_public_config() from public, anon, authenticated;
grant execute on function public.get_public_config() to anon, authenticated;

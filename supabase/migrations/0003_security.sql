-- EOMS Lite — 0003: RLS, table privileges, function EXECUTE privileges.
--
-- Principle: default deny. The API roles (anon, authenticated) get NO direct table writes and
-- anon gets NO table access at all. All mutation goes through the audited SECURITY DEFINER
-- functions in 0002. Admins may read tables through RLS policies keyed on public.is_admin().
--
-- Function owner must be a role with BYPASSRLS (the migration owner `postgres` on Supabase);
-- SECURITY DEFINER bodies read tables the caller cannot. Do NOT enable FORCE ROW LEVEL SECURITY.

-- 1. Nothing is granted by default, now or for future objects.
revoke all on schema eoms_private from public, anon, authenticated;
revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema eoms_private from public, anon, authenticated;

alter default privileges in schema public revoke all on tables    from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema eoms_private revoke all on functions from public, anon, authenticated;

-- 2. RLS on every table. No policy for anon => anon sees nothing even if a grant slips in.
alter table public.admins              enable row level security;
alter table public.app_settings        enable row level security;
alter table public.exam_sessions       enable row level security;
alter table public.rooms               enable row level security;
alter table public.session_rooms       enable row level security;
alter table public.import_batches      enable row level security;
alter table public.schedule            enable row level security;
alter table public.allocations         enable row level security;
alter table public.admin_authorizations enable row level security;
alter table public.employee_flags      enable row level security;
alter table public.check_attempts      enable row level security;
alter table public.audit_log           enable row level security;

-- 3. Admin read access (SELECT only). Writes happen exclusively inside RPCs.
do $$
declare
  t text;
begin
  foreach t in array array[
    'admins', 'app_settings', 'exam_sessions', 'rooms', 'session_rooms', 'import_batches',
    'schedule', 'allocations', 'admin_authorizations', 'employee_flags', 'check_attempts', 'audit_log'
  ]
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_admin_read', t);
  end loop;
end;
$$;

-- 4. Function EXECUTE privileges (explicit allow-list).
-- Public check-in surface: the ONLY things an unauthenticated visitor can call.
grant execute on function public.get_checkin_status()   to anon, authenticated;
grant execute on function public.checkin(text)          to anon, authenticated;

-- Admin surface: authenticated only; each function re-verifies admin status inside.
grant execute on function public.is_admin()                                              to authenticated;
grant execute on function public.admin_authorize_late(text, uuid, text, timestamptz)     to authenticated;
grant execute on function public.admin_authorize_reentry(text, uuid, text, timestamptz)  to authenticated;
grant execute on function public.admin_revoke_authorization(uuid, text)                  to authenticated;
grant execute on function public.admin_release(uuid, text)                               to authenticated;
grant execute on function public.admin_reassign(uuid, uuid, text)                        to authenticated;
grant execute on function public.admin_flag_employee(text, uuid, text)                   to authenticated;
grant execute on function public.admin_resolve_flag(uuid, text, text)                    to authenticated;

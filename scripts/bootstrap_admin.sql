-- Create the FIRST administrator on a fresh Supabase project. Run in the SQL editor as the project owner.
--
-- 1. Authentication -> Users -> "Add user" (email + a strong unique password). Disable public sign-ups first:
--    Authentication -> Sign In / Providers -> turn OFF "Allow new users to sign up".
-- 2. Replace the two values below, then run this statement.
--
-- Afterwards, add further named administrators the same way (one row each). There is no shared account and no
-- self-registration: a signed-in user who is not in this table sees only an "No administrator access" screen.
insert into public.admins (user_id, email, display_name)
values ('00000000-0000-0000-0000-000000000000',   -- <- the user's id from Authentication -> Users
        'first.admin@your-institution.example',
        'First Admin');

-- Deactivate an administrator (takes effect on their next request):
--   update public.admins set is_active = false where email = 'someone@your-institution.example';

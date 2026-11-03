-- EOMS Lite — 0008 (product phase): branding/settings, public config, retention/maintenance, client-IP hardening.
-- Additive. Earlier migrations are not edited.

-- ---------------------------------------------------------------------------
-- Branding / display settings (single row)
-- ---------------------------------------------------------------------------
create table public.app_branding (
  id                       smallint primary key default 1 check (id = 1),
  institution_name         text not null default 'Your Institution',
  exam_cell_name           text not null default 'Examination Cell',
  app_title                text not null default 'Invigilator Check-In',
  logo_data_url            text,
  contact_instructions     text not null default 'Please contact the examination cell.',
  support_info             text,
  default_items_per_page   smallint not null default 25 check (default_items_per_page between 10 and 100),
  updated_at               timestamptz not null default now(),
  updated_by               uuid,
  constraint app_branding_logo_ck
    check (logo_data_url is null
           or (logo_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' and char_length(logo_data_url) <= 200000)),
  constraint app_branding_lengths_ck
    check (char_length(institution_name) between 1 and 120 and char_length(exam_cell_name) between 1 and 120
           and char_length(app_title) between 1 and 80 and char_length(contact_instructions) <= 500
           and char_length(coalesce(support_info, '')) <= 500)
);
insert into public.app_branding (id) values (1);

-- Retention settings (hours / days)
insert into public.app_settings (key, int_value) values
  ('retention_attempts_hours', 48),          -- check_attempts (throttle records)
  ('retention_staging_days', 7),             -- abandoned import staging (status staging/validated)
  ('retention_committed_rows_days', 90)      -- staged rows of committed/cancelled batches
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Client IP for throttling. NEVER trust the left-most X-Forwarded-For entry (the client can write it).
-- Preference: cf-connecting-ip (set by Cloudflare, overwritten on ingress), else the RIGHT-most entry
-- (appended by the trusted proxy nearest to the database). Which header Supabase actually provides must be
-- verified on the real project with admin_debug_request_headers(); until then the throttle is best-effort.
-- ---------------------------------------------------------------------------
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
  v_ip := btrim(coalesce(v_headers ->> 'cf-connecting-ip', ''));
  if v_ip = '' then
    v_ip := btrim((string_to_array(coalesce(v_headers ->> 'x-forwarded-for', ''), ','))[
              coalesce(array_length(string_to_array(coalesce(v_headers ->> 'x-forwarded-for', ''), ','), 1), 1)]);
  end if;
  if v_ip is null or v_ip = '' then
    return null;
  end if;
  return encode(sha256(convert_to(v_ip, 'UTF8')), 'hex');
end;
$$;

-- ---------------------------------------------------------------------------
-- Public config (anon): branding only, nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.get_public_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'institution_name', b.institution_name,
    'exam_cell_name', b.exam_cell_name,
    'app_title', b.app_title,
    'logo_data_url', b.logo_data_url,
    'contact_instructions', b.contact_instructions,
    'support_info', b.support_info)
  from public.app_branding b where b.id = 1
$$;

create or replace function public.admin_get_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_b public.app_branding;
begin
  perform eoms_private.require_admin();
  select * into v_b from public.app_branding where id = 1;
  return to_jsonb(v_b) || jsonb_build_object(
    'retention', (select jsonb_object_agg(key, int_value) from public.app_settings
                   where key like 'retention\_%' or key like 'import\_%' or key like 'throttle\_%'));
end;
$$;

-- NULL = unchanged. p_clear_logo removes the logo. The logo must be a small PNG/JPEG/WebP data URL (SVG is refused: XSS).
create or replace function public.admin_update_settings(
  p_institution_name text default null, p_exam_cell_name text default null, p_app_title text default null,
  p_logo_data_url text default null, p_clear_logo boolean default false,
  p_contact_instructions text default null, p_support_info text default null,
  p_items_per_page integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin uuid := eoms_private.require_admin();
  v_old   public.app_branding;
  v_new   public.app_branding;
  v_logo  text;
begin
  select * into v_old from public.app_branding where id = 1 for update;
  v_logo := case when coalesce(p_clear_logo, false) then null
                 when p_logo_data_url is not null then p_logo_data_url
                 else v_old.logo_data_url end;
  if p_institution_name is not null and btrim(p_institution_name) = '' then
    raise exception 'institution name cannot be empty' using errcode = '22023';
  end if;
  if p_exam_cell_name is not null and btrim(p_exam_cell_name) = '' then
    raise exception 'examination cell name cannot be empty' using errcode = '22023';
  end if;
  if p_app_title is not null and btrim(p_app_title) = '' then
    raise exception 'application title cannot be empty' using errcode = '22023';
  end if;
  begin
    update public.app_branding set
      institution_name = coalesce(btrim(p_institution_name), institution_name),
      exam_cell_name = coalesce(btrim(p_exam_cell_name), exam_cell_name),
      app_title = coalesce(btrim(p_app_title), app_title),
      logo_data_url = v_logo,
      contact_instructions = coalesce(btrim(p_contact_instructions), contact_instructions),
      support_info = case when p_support_info is null then support_info else nullif(btrim(p_support_info), '') end,
      default_items_per_page = coalesce(p_items_per_page, default_items_per_page),
      updated_at = now(), updated_by = v_admin
    where id = 1 returning * into v_new;
  exception when check_violation then
    raise exception 'invalid settings: check lengths, items per page (10-100) and that the logo is a PNG/JPEG/WebP data URL under 200 KB'
      using errcode = '22023';
  end;
  -- the (large) logo is not copied into the audit log; only its presence/size is
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'settings.update', 'app_branding', '1',
    to_jsonb(v_old) - 'logo_data_url' || jsonb_build_object('logo_chars', char_length(coalesce(v_old.logo_data_url, ''))),
    to_jsonb(v_new) - 'logo_data_url' || jsonb_build_object('logo_chars', char_length(coalesce(v_new.logo_data_url, ''))));
  return public.get_public_config() || jsonb_build_object('ok', true, 'default_items_per_page', v_new.default_items_per_page);
end;
$$;

-- ---------------------------------------------------------------------------
-- Retention / maintenance. Audit records are NEVER deleted.
-- eoms_private.run_maintenance() is for the database owner / pg_cron (not API-exposed);
-- public.admin_run_maintenance() lets an admin trigger it and records who did.
-- ---------------------------------------------------------------------------
create or replace function eoms_private.run_maintenance()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_attempts  integer;
  v_abandoned integer := 0;
  v_rows_old  integer;
  v_b         record;
  v_n         integer;
begin
  delete from public.check_attempts
   where at < now() - make_interval(hours => coalesce(eoms_private.setting_int('retention_attempts_hours'), 48));
  get diagnostics v_attempts = row_count;

  for v_b in
    select id, status, row_count from public.import_batches
     where status in ('staging', 'validated')
       and uploaded_at < now() - make_interval(days => coalesce(eoms_private.setting_int('retention_staging_days'), 7))
     for update
  loop
    delete from public.import_rows where batch_id = v_b.id;
    update public.import_batches set status = 'cancelled', row_count = 0, error = 'abandoned: cleaned up by maintenance'
     where id = v_b.id;
    perform eoms_private.audit('system', null, 'import.abandoned_cleanup', 'import_batch', v_b.id::text,
      jsonb_build_object('status', v_b.status, 'rows', v_b.row_count), jsonb_build_object('status', 'cancelled'));
    v_abandoned := v_abandoned + 1;
  end loop;

  delete from public.import_rows r using public.import_batches b
   where r.batch_id = b.id and b.status in ('committed', 'cancelled')
     and coalesce(b.committed_at, b.uploaded_at)
         < now() - make_interval(days => coalesce(eoms_private.setting_int('retention_committed_rows_days'), 90));
  get diagnostics v_rows_old = row_count;

  return jsonb_build_object('check_attempts_deleted', v_attempts, 'abandoned_batches_cancelled', v_abandoned,
                            'old_import_rows_deleted', v_rows_old);
end;
$$;

create or replace function public.admin_run_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '10s'
as $$
declare
  v_admin uuid := eoms_private.require_admin();
  v_res   jsonb;
begin
  perform eoms_private.lock_imports();
  v_res := eoms_private.run_maintenance();
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'maintenance.run', 'maintenance', null, null, v_res);
  return v_res || jsonb_build_object('ok', true);
end;
$$;

-- Diagnostic for the staging smoke test: which headers does the platform pass to the database?
create or replace function public.admin_debug_request_headers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_h jsonb;
begin
  perform eoms_private.require_admin();
  begin
    v_h := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_h := null;
  end;
  -- never echo credentials back
  return jsonb_build_object('headers', coalesce(v_h, '{}'::jsonb) - 'authorization' - 'apikey' - 'cookie',
                            'client_ip_hash_used', eoms_private.client_ip_hash());
end;
$$;

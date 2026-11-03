-- EOMS Lite — 0006 (Phase 2A): schedule import (two stages, staged in the database, non-destructive by default).
--
--   Stage A (dry run, never touches public.schedule):
--     admin_import_begin -> admin_import_add_rows (bounded chunks, repeatable) -> admin_import_validate -> admin_import_preview
--   Stage B (explicit admin action):
--     admin_import_commit(p_confirm => true, p_on_conflict => 'skip'|'abort')
--   Separate explicit action for replacing conflicting existing rows:
--     admin_import_replace_conflicts
--   admin_import_cancel discards an uncommitted batch.
--
-- All functions: SECURITY DEFINER, search_path = '', admin identity from auth.uid() only, audited.

create or replace function eoms_private.lock_imports()
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- Serialises schedule-import commits/replacements so two simultaneous imports cannot interleave.
  perform pg_advisory_xact_lock(hashtextextended('eoms:schedule-import', 0));
end;
$$;

create or replace function eoms_private.setting_int(p_key text)
returns integer
language sql
stable
set search_path = ''
as $$ select int_value from public.app_settings where key = p_key $$;

create or replace function eoms_private.import_summary(p_batch uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'batch_id', b.id, 'status', b.status, 'filename', b.filename,
    'rows', b.row_count, 'valid', b.valid_count, 'invalid', b.invalid_count,
    'duplicate', b.duplicate_in_batch_count + b.exact_duplicate_count,
    'duplicate_in_batch', b.duplicate_in_batch_count,
    'exact_duplicate_existing', b.exact_duplicate_count,
    'conflict', b.conflict_count,
    'inserted', b.inserted_count, 'replaced', b.replaced_count, 'error', b.error)
    from public.import_batches b where b.id = p_batch
$$;

create or replace function eoms_private.import_rows_json(p_batch uuid, p_status text, p_limit integer, p_offset integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'row', x.row_number, 'status', x.status, 'errors', x.errors, 'outcome', x.outcome,
           'employee_id', coalesce(x.employee_id, x.raw_employee_id),
           'name', coalesce(x.employee_name, x.raw_name),
           'department', coalesce(x.department, x.raw_department),
           'date', coalesce(x.exam_date::text, x.raw_date),
           'session', coalesce(x.session_label, x.raw_session),
           'existing', x.existing) order by x.row_number), '[]'::jsonb)
    from (
      select * from public.import_rows r
       where r.batch_id = p_batch
         and (p_status is null or (p_status = 'problems' and r.status <> 'valid') or r.status = p_status)
       order by r.row_number
       limit greatest(1, least(coalesce(p_limit, 100), 500)) offset greatest(0, coalesce(p_offset, 0))
    ) x
$$;

-- ---------------------------------------------------------------------------
-- Stage A
-- ---------------------------------------------------------------------------

create or replace function public.admin_import_begin(
  p_filename text, p_file_size_bytes bigint default null, p_declared_rows integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin uuid := eoms_private.require_admin();
  v_name  text := nullif(btrim(coalesce(p_filename, '')), '');
  v_max_b integer := eoms_private.setting_int('import_max_file_bytes');
  v_max_r integer := eoms_private.setting_int('import_max_rows');
  v_chunk integer := eoms_private.setting_int('import_chunk_max_rows');
  v_id    uuid;
begin
  if v_name is null or char_length(v_name) > 255 then
    raise exception 'file name is required (maximum 255 characters)' using errcode = '22023';
  end if;
  if p_file_size_bytes is not null and (p_file_size_bytes < 0 or p_file_size_bytes > v_max_b) then
    raise exception 'file is larger than the limit of % bytes', v_max_b using errcode = '22023';
  end if;
  if p_declared_rows is not null and (p_declared_rows < 1 or p_declared_rows > v_max_r) then
    raise exception 'file has % rows; the limit is % rows per import', p_declared_rows, v_max_r using errcode = '22023';
  end if;

  insert into public.import_batches (uploaded_by, filename, status, declared_rows, declared_file_bytes)
  values (v_admin, v_name, 'staging', p_declared_rows, p_file_size_bytes)
  returning id into v_id;

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'import.begin', 'import_batch', v_id::text, null,
    jsonb_build_object('filename', v_name, 'declared_rows', p_declared_rows, 'declared_file_bytes', p_file_size_bytes));
  return jsonb_build_object('ok', true, 'batch_id', v_id,
    'limits', jsonb_build_object('max_rows', v_max_r, 'max_chunk_rows', v_chunk, 'max_file_bytes', v_max_b));
end;
$$;

-- p_rows: JSON array of {row, employee_id, name, department, date, session}; values exactly as read from the file
-- (the browser may pre-convert Excel date cells to ISO strings). Idempotent per row number, so a retried chunk is safe.
create or replace function public.admin_import_add_rows(p_batch_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin uuid := eoms_private.require_admin();
  v_b     public.import_batches;
  v_chunk integer := eoms_private.setting_int('import_chunk_max_rows');
  v_max_r integer := eoms_private.setting_int('import_max_rows');
  v_n     integer;
  v_total integer;
begin
  perform eoms_private.assert_read_committed();
  select * into v_b from public.import_batches where id = p_batch_id for update;   -- serialises chunks of one batch
  if v_b.id is null then
    raise exception 'import batch not found' using errcode = '22023';
  end if;
  if v_b.status not in ('staging', 'validated') then
    raise exception 'batch is % and cannot accept more rows', v_b.status using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a JSON array' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n = 0 then
    raise exception 'no rows supplied' using errcode = '22023';
  end if;
  if v_n > v_chunk then
    raise exception 'too many rows in one call (% > chunk limit %). Send smaller chunks', v_n, v_chunk using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where jsonb_typeof(e) <> 'object' or coalesce(e ->> 'row', '') !~ '^[0-9]{1,7}$' or (e ->> 'row')::int < 1) then
    raise exception 'every element must be an object with a positive integer "row"' using errcode = '22023';
  end if;
  if (select count(distinct (e ->> 'row')::int) from jsonb_array_elements(p_rows) e) <> v_n then
    raise exception 'duplicate row numbers inside one chunk' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where greatest(char_length(coalesce(e ->> 'employee_id', '')), char_length(coalesce(e ->> 'name', '')),
                             char_length(coalesce(e ->> 'department', '')), char_length(coalesce(e ->> 'date', '')),
                             char_length(coalesce(e ->> 'session', ''))) > 300) then
    raise exception 'a field is longer than 300 characters' using errcode = '22023';
  end if;

  insert into public.import_rows (batch_id, row_number, raw_employee_id, raw_name, raw_department, raw_date, raw_session)
  select p_batch_id, (e ->> 'row')::int, e ->> 'employee_id', e ->> 'name', e ->> 'department', e ->> 'date', e ->> 'session'
    from jsonb_array_elements(p_rows) e
  on conflict (batch_id, row_number) do update
     set raw_employee_id = excluded.raw_employee_id, raw_name = excluded.raw_name,
         raw_department = excluded.raw_department, raw_date = excluded.raw_date, raw_session = excluded.raw_session,
         status = 'pending', errors = '{}', existing = null, outcome = null;

  select count(*) into v_total from public.import_rows where batch_id = p_batch_id;
  if v_total > v_max_r then
    raise exception 'batch would have % rows; the limit is % rows per import', v_total, v_max_r using errcode = '22023';
  end if;

  update public.import_batches set status = 'staging', row_count = v_total, validated_at = null where id = p_batch_id;
  return jsonb_build_object('ok', true, 'batch_id', p_batch_id, 'staged_rows', v_total);
end;
$$;

create or replace function public.admin_import_validate(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin uuid := eoms_private.require_admin();
  v_b     public.import_batches;
  v_sum   jsonb;
begin
  perform eoms_private.assert_read_committed();
  select * into v_b from public.import_batches where id = p_batch_id for update;
  if v_b.id is null then
    raise exception 'import batch not found' using errcode = '22023';
  end if;
  if v_b.status not in ('staging', 'validated') then
    raise exception 'batch is % and cannot be validated', v_b.status using errcode = '22023';
  end if;
  if not exists (select 1 from public.import_rows where batch_id = p_batch_id) then
    raise exception 'batch has no rows' using errcode = '22023';
  end if;

  perform eoms_private.import_validate(p_batch_id);        -- read-only with respect to public.schedule
  v_sum := eoms_private.import_summary(p_batch_id);

  perform eoms_private.audit('admin:' || v_admin, v_admin, 'import.validate', 'import_batch', p_batch_id::text, null, v_sum);
  return jsonb_build_object('ok', true, 'summary', v_sum,
    'problems', eoms_private.import_rows_json(p_batch_id, 'problems', 50, 0));
end;
$$;

-- p_status: null = all rows, 'problems' = everything not valid, or one status value.
create or replace function public.admin_import_preview(
  p_batch_id uuid, p_status text default null, p_limit integer default 100, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform eoms_private.require_admin();
  if not exists (select 1 from public.import_batches where id = p_batch_id) then
    raise exception 'import batch not found' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in
     ('problems', 'pending', 'valid', 'invalid', 'duplicate_in_batch', 'exact_duplicate', 'conflict') then
    raise exception 'unknown status filter' using errcode = '22023';
  end if;
  return jsonb_build_object('summary', eoms_private.import_summary(p_batch_id),
                            'rows', eoms_private.import_rows_json(p_batch_id, p_status, p_limit, p_offset));
end;
$$;

create or replace function public.admin_import_cancel(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_admin  uuid := eoms_private.require_admin();
  v_reason text := eoms_private.require_reason(p_reason);
  v_b      public.import_batches;
begin
  select * into v_b from public.import_batches where id = p_batch_id for update;
  if v_b.id is null then
    raise exception 'import batch not found' using errcode = '22023';
  end if;
  if v_b.status not in ('staging', 'validated') then
    raise exception 'batch is % and cannot be cancelled', v_b.status using errcode = '22023';
  end if;
  delete from public.import_rows where batch_id = p_batch_id;       -- free staging space
  update public.import_batches set status = 'cancelled', row_count = 0 where id = p_batch_id;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'import.cancel', 'import_batch', p_batch_id::text,
    jsonb_build_object('status', v_b.status, 'rows', v_b.row_count), jsonb_build_object('reason', v_reason));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stage B
-- ---------------------------------------------------------------------------

-- Business rejections return {ok:false, code, message} (no exception) so the revalidated counts and the audit
-- row persist. The insert itself runs in a sub-transaction: any error rolls back every row of the import.
create or replace function public.admin_import_commit(
  p_batch_id uuid, p_confirm boolean, p_on_conflict text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '10s'
as $$
declare
  v_admin    uuid := eoms_private.require_admin();
  v_b        public.import_batches;
  v_prev     jsonb;
  v_now      jsonb;
  v_inserted integer;
begin
  perform eoms_private.assert_read_committed();
  if not coalesce(p_confirm, false) then
    raise exception 'explicit confirmation required (p_confirm = true)' using errcode = '22023';
  end if;
  if p_on_conflict is not null and p_on_conflict not in ('skip', 'abort') then
    raise exception 'p_on_conflict must be skip or abort' using errcode = '22023';
  end if;

  perform eoms_private.lock_imports();                      -- one import commit at a time
  select * into v_b from public.import_batches where id = p_batch_id for update;
  if v_b.id is null then
    raise exception 'import batch not found' using errcode = '22023';
  end if;
  if v_b.status <> 'validated' then
    return eoms_private.reject('BAD_STATE', format('Batch is %s; only a validated batch can be committed.', v_b.status));
  end if;
  if (select count(*) from public.import_rows where batch_id = p_batch_id) > eoms_private.setting_int('import_max_rows') then
    raise exception 'batch exceeds the row limit' using errcode = '22023';
  end if;

  -- Revalidate inside the database: the live schedule/sessions may have changed since the preview.
  v_prev := eoms_private.import_summary(p_batch_id);
  perform eoms_private.import_validate(p_batch_id);
  v_now := eoms_private.import_summary(p_batch_id);
  select * into v_b from public.import_batches where id = p_batch_id;

  if (v_prev - 'status' - 'error' - 'inserted' - 'replaced') is distinct from (v_now - 'status' - 'error' - 'inserted' - 'replaced') then
    perform eoms_private.audit('admin:' || v_admin, v_admin, 'import.commit_rejected', 'import_batch', p_batch_id::text,
      v_prev, v_now || jsonb_build_object('code', 'CHANGED_SINCE_PREVIEW'));
    return eoms_private.reject('CHANGED_SINCE_PREVIEW',
      'The data changed since the preview. Review the new counts and commit again.', jsonb_build_object('summary', v_now));
  end if;
  if v_b.invalid_count > 0 then
    return eoms_private.reject('INVALID_ROWS',
      format('%s rows are invalid. Fix the file and import again; nothing was imported.', v_b.invalid_count),
      jsonb_build_object('summary', v_now));
  end if;
  if v_b.conflict_count > 0 and p_on_conflict is null then
    return eoms_private.reject('CONFLICT_DECISION_REQUIRED',
      format('%s rows conflict with existing schedule entries. Choose skip or abort.', v_b.conflict_count),
      jsonb_build_object('summary', v_now));
  end if;
  if v_b.conflict_count > 0 and p_on_conflict = 'abort' then
    perform eoms_private.audit('admin:' || v_admin, v_admin, 'import.commit_rejected', 'import_batch', p_batch_id::text,
      v_now, jsonb_build_object('code', 'ABORTED_ON_CONFLICT'));
    return eoms_private.reject('ABORTED_ON_CONFLICT', 'Import aborted because of conflicts; nothing was imported.',
      jsonb_build_object('summary', v_now));
  end if;
  if v_b.valid_count = 0 then
    return eoms_private.reject('NOTHING_TO_IMPORT', 'There are no new rows to import.', jsonb_build_object('summary', v_now));
  end if;

  begin
    insert into public.schedule (employee_id, employee_name, department, exam_date, session_label, import_batch_id)
    select employee_id, employee_name, department, exam_date, session_label, p_batch_id
      from public.import_rows where batch_id = p_batch_id and status = 'valid' order by row_number;
    get diagnostics v_inserted = row_count;
    if v_inserted <> v_b.valid_count then
      raise exception 'inserted % rows but expected %', v_inserted, v_b.valid_count;
    end if;

    update public.import_rows
       set outcome = case status when 'valid' then 'inserted'
                                 when 'conflict' then 'skipped_conflict'
                                 when 'exact_duplicate' then 'skipped_exact_duplicate'
                                 when 'duplicate_in_batch' then 'skipped_duplicate_in_batch' end
     where batch_id = p_batch_id;
    update public.import_batches
       set status = 'committed', inserted_count = v_inserted, committed_at = now(), committed_by = v_admin, error = null
     where id = p_batch_id;
    perform eoms_private.audit('admin:' || v_admin, v_admin, 'import.commit', 'import_batch', p_batch_id::text,
      v_now, eoms_private.import_summary(p_batch_id) || jsonb_build_object('on_conflict', p_on_conflict));
  exception when others then
    -- the sub-transaction above is rolled back: no schedule rows from this import exist
    update public.import_batches set error = left(sqlerrm, 500) where id = p_batch_id;
    perform eoms_private.audit('admin:' || v_admin, v_admin, 'import.commit_failed', 'import_batch', p_batch_id::text,
      v_now, jsonb_build_object('error', left(sqlerrm, 500), 'sqlstate', sqlstate));
    return eoms_private.reject('COMMIT_FAILED', 'The import failed and nothing was imported. You can try again.',
      jsonb_build_object('summary', eoms_private.import_summary(p_batch_id)));
  end;

  return jsonb_build_object('ok', true, 'summary', eoms_private.import_summary(p_batch_id));
end;
$$;

-- Explicit, separately confirmed replacement of existing rows that conflicted in a COMMITTED batch.
-- Only name/department change (the key is the identity). Every replaced row gets its own before/after audit row.
create or replace function public.admin_import_replace_conflicts(p_batch_id uuid, p_confirm boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '10s'
as $$
declare
  v_admin    uuid := eoms_private.require_admin();
  v_reason   text := eoms_private.require_reason(p_reason);
  v_b        public.import_batches;
  v_ref      text := eoms_private.request_ref();
  v_replaced integer;
begin
  perform eoms_private.assert_read_committed();
  if not coalesce(p_confirm, false) then
    raise exception 'explicit confirmation required (p_confirm = true)' using errcode = '22023';
  end if;

  perform eoms_private.lock_imports();
  select * into v_b from public.import_batches where id = p_batch_id for update;
  if v_b.id is null then
    raise exception 'import batch not found' using errcode = '22023';
  end if;
  if v_b.status <> 'committed' then
    raise exception 'only a committed batch can replace conflicts (batch is %)', v_b.status using errcode = '22023';
  end if;

  with target as (
    select r.row_number, s.employee_id, s.exam_date, s.session_label,
           s.employee_name as old_name, s.department as old_dept, s.import_batch_id as old_batch,
           r.employee_name as new_name, r.department as new_dept
      from public.import_rows r
      join public.schedule s on s.employee_id = r.employee_id and s.exam_date = r.exam_date and s.session_label = r.session_label
     where r.batch_id = p_batch_id and r.outcome = 'skipped_conflict'
       and (s.employee_name, s.department) is distinct from (r.employee_name, r.department)
       for update of s
  ),
  upd as (
    update public.schedule s
       set employee_name = t.new_name, department = t.new_dept, import_batch_id = p_batch_id
      from target t
     where s.employee_id = t.employee_id and s.exam_date = t.exam_date and s.session_label = t.session_label
    returning t.row_number, t.employee_id, t.exam_date, t.session_label, t.old_name, t.old_dept, t.old_batch,
              t.new_name, t.new_dept
  ),
  aud as (
    insert into public.audit_log (actor, actor_user_id, action, entity, entity_id, before, after, request_id)
    select 'admin:' || v_admin, v_admin, 'schedule.replace', 'schedule',
           u.employee_id || '|' || u.exam_date || '|' || u.session_label,
           jsonb_build_object('employee_name', u.old_name, 'department', u.old_dept, 'import_batch_id', u.old_batch),
           jsonb_build_object('employee_name', u.new_name, 'department', u.new_dept, 'import_batch_id', p_batch_id,
                              'reason', v_reason, 'row', u.row_number),
           v_ref
      from upd u
    returning 1
  )
  update public.import_rows r set outcome = 'replaced'
    from upd where r.batch_id = p_batch_id and r.row_number = upd.row_number;
  get diagnostics v_replaced = row_count;

  update public.import_batches set replaced_count = replaced_count + v_replaced where id = p_batch_id;
  perform eoms_private.audit('admin:' || v_admin, v_admin, 'import.replace_conflicts', 'import_batch', p_batch_id::text,
    null, jsonb_build_object('replaced', v_replaced, 'reason', v_reason));
  return jsonb_build_object('ok', true, 'replaced', v_replaced, 'summary', eoms_private.import_summary(p_batch_id));
end;
$$;

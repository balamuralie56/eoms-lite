-- EOMS Lite — 0001: schema, constraints, integrity triggers.
-- Independent of the production EOMS. No data from, or reference to, that system.
--
-- Conventions
--   * All timestamps are timestamptz. Exam windows are entered in Asia/Kolkata by the
--     admin UI and stored as absolute instants; the database never relies on a
--     session time zone.
--   * Employee IDs are stored normalised: upper(btrim(x)).
--   * Internal helpers live in schema eoms_private, which is NOT exposed through the API.

create schema if not exists eoms_private;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function eoms_private.lock_session(p_session uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- Transaction-level advisory lock: released automatically at COMMIT/ROLLBACK.
  -- Every writer that can change allocations for a session takes this same lock.
  perform pg_advisory_xact_lock(hashtextextended('eoms:session:' || p_session::text, 0));
end;
$$;

create or replace function eoms_private.assert_read_committed()
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- The allocation guarantee relies on every statement taking a fresh snapshot after
  -- the advisory lock is acquired. REPEATABLE READ / SERIALIZABLE would break that.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'EOMS allocation requires READ COMMITTED isolation (found %)',
      current_setting('transaction_isolation')
      using errcode = '25000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.admins (
  user_id      uuid primary key,              -- = auth.users.id (Supabase Auth). No FK: keeps the schema portable.
  email        text not null,
  display_name text not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.app_settings (
  key       text primary key,
  int_value integer not null
);
insert into public.app_settings (key, int_value) values
  ('throttle_max_failures',   60),   -- failed lookups allowed per client-IP hash ...
  ('throttle_window_seconds', 600);  -- ... within this window

create table public.exam_sessions (
  id                uuid primary key default gen_random_uuid(),
  exam_date         date not null,
  session_label     text not null check (session_label in ('FN', 'AN')),
  checkin_opens_at  timestamptz not null,
  checkin_closes_at timestamptz not null,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  constraint exam_sessions_window_ck check (checkin_closes_at > checkin_opens_at),
  constraint exam_sessions_date_label_uq unique (exam_date, session_label),
  -- Overlapping ACTIVE check-in windows are impossible, across all sessions.
  -- Half-open [opens, closes): a session may open exactly when another closes.
  constraint exam_sessions_no_overlap
    exclude using gist (tstzrange(checkin_opens_at, checkin_closes_at, '[)') with &&)
    where (is_active)
);

create table public.rooms (
  id        uuid primary key default gen_random_uuid(),
  room_code text not null,
  building  text,
  floor     text,
  is_active boolean not null default true,
  constraint rooms_code_ck check (room_code = btrim(room_code) and room_code <> ''),
  constraint rooms_code_uq unique (room_code)
);

-- Invigilator capacity per (session, room). Unrelated to student seating capacity.
create table public.session_rooms (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null references public.exam_sessions (id),
  room_id          uuid not null references public.rooms (id),
  max_invigilators integer not null check (max_invigilators >= 1),
  is_active        boolean not null default true,
  constraint session_rooms_session_room_uq unique (session_id, room_id),
  constraint session_rooms_id_session_uq unique (id, session_id)  -- target of composite FK below
);
create index session_rooms_session_idx on public.session_rooms (session_id) where is_active;

create table public.import_batches (
  id          uuid primary key default gen_random_uuid(),
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  filename    text,
  row_count   integer,
  status      text not null default 'pending' check (status in ('pending', 'committed', 'rejected'))
);

create table public.schedule (
  employee_id     text not null,
  employee_name   text not null,
  department      text not null,
  exam_date       date not null,
  session_label   text not null check (session_label in ('FN', 'AN')),
  import_batch_id uuid references public.import_batches (id),
  constraint schedule_employee_id_ck
    check (employee_id = upper(btrim(employee_id)) and employee_id <> ''),
  constraint schedule_pk primary key (employee_id, exam_date, session_label)
);
create index schedule_batch_idx on public.schedule (import_batch_id);

create table public.allocations (
  id                        uuid primary key default gen_random_uuid(),
  seq                       bigint generated always as identity,  -- total insertion order (used by tests/reports)
  session_id                uuid not null,
  session_room_id           uuid not null,
  employee_id               text not null,
  round                     integer not null check (round >= 1),
  allocated_at              timestamptz not null default now(),
  source                    text not null
                              check (source in ('normal', 'admin_late', 'admin_reentry', 'admin_correction')),
  released_at               timestamptz,
  released_by               uuid,
  release_reason            text,
  supersedes_allocation_id  uuid references public.allocations (id),
  created_by                uuid,                                  -- admin uuid when source is admin_*
  constraint allocations_employee_id_ck
    check (employee_id = upper(btrim(employee_id)) and employee_id <> ''),
  constraint allocations_release_ck
    check ((released_at is null and released_by is null and release_reason is null)
        or (released_at is not null and release_reason is not null and btrim(release_reason) <> '')),
  -- The room must belong to the same session as the allocation.
  constraint allocations_room_session_fk
    foreign key (session_room_id, session_id) references public.session_rooms (id, session_id),
  constraint allocations_session_fk foreign key (session_id) references public.exam_sessions (id)
);

-- FINAL INTEGRITY SAFEGUARD: at most one ACTIVE allocation per employee per session.
create unique index allocations_one_active_per_employee
  on public.allocations (session_id, employee_id)
  where released_at is null;
create index allocations_room_active_idx
  on public.allocations (session_room_id) where released_at is null;
create index allocations_employee_idx on public.allocations (employee_id, session_id);

-- One-shot, admin-created permits: waive the check-in window (late) or allow re-entry
-- after a release. They never waive schedule validation, flags, room activity or capacity.
create table public.admin_authorizations (
  id                      uuid primary key default gen_random_uuid(),
  kind                    text not null check (kind in ('late', 'reentry')),
  session_id              uuid not null references public.exam_sessions (id),
  employee_id             text not null check (employee_id = upper(btrim(employee_id)) and employee_id <> ''),
  reason                  text not null check (btrim(reason) <> ''),
  authorized_by           uuid not null,
  authorized_at           timestamptz not null default now(),
  expires_at              timestamptz,
  revoked_at              timestamptz,
  revoked_by              uuid,
  consumed_at             timestamptz,
  consumed_allocation_id  uuid references public.allocations (id)
);
create unique index admin_authorizations_one_open
  on public.admin_authorizations (session_id, employee_id)
  where consumed_at is null and revoked_at is null;
create index admin_authorizations_employee_idx
  on public.admin_authorizations (employee_id) where consumed_at is null and revoked_at is null;

-- Exception / verification workflow. Only admins create and resolve flags.
create table public.employee_flags (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references public.exam_sessions (id),
  employee_id     text not null check (employee_id = upper(btrim(employee_id)) and employee_id <> ''),
  reason          text not null check (btrim(reason) <> ''),
  status          text not null default 'pending' check (status in ('pending', 'cleared', 'blocked')),
  created_by      uuid not null,
  created_at      timestamptz not null default now(),
  resolved_by     uuid,
  resolved_at     timestamptz,
  resolution_note text
);
create unique index employee_flags_one_pending
  on public.employee_flags (session_id, employee_id) where status = 'pending';
create index employee_flags_lookup_idx
  on public.employee_flags (session_id, employee_id) where status in ('pending', 'blocked');

-- Abuse throttling. Failures only (keeps write load low). ip_hash = sha256 of client IP.
create table public.check_attempts (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  ip_hash     text not null,
  employee_id text,
  outcome     text not null
);
create index check_attempts_ip_idx on public.check_attempts (ip_hash, at desc);

create table public.audit_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor         text not null,            -- 'admin:<uuid>' | 'employee:<ID>' | 'system'
  actor_user_id uuid,                     -- set for admin actions
  action        text not null,
  entity        text,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  request_id    text
);
create index audit_log_at_idx on public.audit_log (at desc);
create index audit_log_entity_idx on public.audit_log (entity, entity_id);

-- ---------------------------------------------------------------------------
-- Append-only audit log (blocks UPDATE/DELETE/TRUNCATE for every role, including the owner;
-- only a superuser deliberately disabling the trigger can bypass it).
-- ---------------------------------------------------------------------------

create or replace function eoms_private.audit_log_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function eoms_private.audit_log_immutable();
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function eoms_private.audit_log_immutable();

-- ---------------------------------------------------------------------------
-- allocations integrity triggers (defence in depth; the RPCs already enforce all of this)
-- ---------------------------------------------------------------------------

create or replace function eoms_private.allocations_guard_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max     integer;
  v_active  boolean;
  v_count   integer;
begin
  -- Re-entrant: the RPCs already hold this lock. Direct inserts get serialised too.
  perform eoms_private.lock_session(new.session_id);

  select sr.max_invigilators, (sr.is_active and r.is_active and s.is_active)
    into v_max, v_active
    from public.session_rooms sr
    join public.rooms r on r.id = sr.room_id
    join public.exam_sessions s on s.id = sr.session_id
   where sr.id = new.session_room_id;

  if v_max is null then
    raise exception 'unknown session room' using errcode = '23503';
  end if;
  if not v_active then
    raise exception 'room or session is not active' using errcode = '23514';
  end if;
  if new.released_at is null then
    select count(*) into v_count
      from public.allocations
     where session_room_id = new.session_room_id and released_at is null;
    if v_count >= v_max then
      raise exception 'room capacity exceeded' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger allocations_guard_insert
  before insert on public.allocations
  for each row execute function eoms_private.allocations_guard_insert();

create or replace function eoms_private.allocations_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Allocations are immutable except for being released (one-way).
  if (new.id, new.seq, new.session_id, new.session_room_id, new.employee_id, new.round,
      new.allocated_at, new.source, new.supersedes_allocation_id, new.created_by)
     is distinct from
     (old.id, old.seq, old.session_id, old.session_room_id, old.employee_id, old.round,
      old.allocated_at, old.source, old.supersedes_allocation_id, old.created_by) then
    raise exception 'allocations are immutable except for release' using errcode = '23514';
  end if;
  if old.released_at is not null
     and (new.released_at is distinct from old.released_at
          or new.released_by is distinct from old.released_by
          or new.release_reason is distinct from old.release_reason) then
    raise exception 'a released allocation cannot be changed or re-activated' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger allocations_guard_update
  before update on public.allocations
  for each row execute function eoms_private.allocations_guard_update();

create or replace function eoms_private.allocations_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'allocations cannot be deleted; release them instead' using errcode = '42501';
end;
$$;

create trigger allocations_no_delete
  before delete on public.allocations
  for each row execute function eoms_private.allocations_no_delete();
create trigger allocations_no_truncate
  before truncate on public.allocations
  for each statement execute function eoms_private.allocations_no_delete();

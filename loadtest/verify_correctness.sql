-- Run after a load test (SQL editor or psql). Every query must return ZERO rows.

-- 1. Duplicate ACTIVE allocations (must be impossible)
select session_id, employee_id, count(*) from public.allocations
 where released_at is null group by 1, 2 having count(*) > 1;

-- 2. Capacity violations
select sr.id, sr.max_invigilators, count(a.id) as active
  from public.session_rooms sr join public.allocations a on a.session_room_id = sr.id and a.released_at is null
 group by sr.id, sr.max_invigilators having count(a.id) > sr.max_invigilators;

-- 3. Allocations in inactive rooms
select a.id from public.allocations a
  join public.session_rooms sr on sr.id = a.session_room_id join public.rooms r on r.id = sr.room_id
 where a.released_at is null and not (sr.is_active and r.is_active);

-- 4. Policy order: replay by seq; any row returned is an allocation that did not go to a minimum-count room.
--    (Valid only when the run had no admin releases/corrections.)
with rooms as (
  select sr.id, sr.max_invigilators as max from public.session_rooms sr where sr.is_active
),
ordered as (
  select a.seq, a.session_room_id, a.session_id from public.allocations a order by a.seq
),
replay as (
  select o.seq, o.session_room_id,
         (select count(*) from public.allocations p
           where p.session_room_id = o.session_room_id and p.seq < o.seq and p.released_at is null) as chosen_count,
         (select min(c) from (
            select r.id, (select count(*) from public.allocations p
                           where p.session_room_id = r.id and p.seq < o.seq and p.released_at is null) as c, r.max
              from rooms r) t
           where t.c < t.max) as min_count
    from ordered o
)
select * from replay where chosen_count <> min_count;

-- Summary (informational)
select (select count(*) from public.allocations where released_at is null) as active_allocations,
       (select count(*) from public.audit_log where action = 'allocation.create') as create_audits;

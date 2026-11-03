-- Load-test fixture. RUN ONLY ON A THROWAWAY STAGING SUPABASE PROJECT, never on production data.
-- Creates one session open for the next 3 hours, 30 rooms, 600 scheduled employees (LT0001..LT0600)
-- and 700 slots, so 500 check-ins fit and a burst test can also exercise ROOMS_FULL if you lower capacity.
-- Re-running requires a clean database (allocations/audit are append-only by design).
do $$
declare
  v_session uuid;
  v_room uuid;
  i int;
begin
  insert into public.exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at)
  values (current_date, 'FN', now() - interval '5 minutes', now() + interval '3 hours')
  returning id into v_session;

  for i in 1..30 loop
    insert into public.rooms (room_code, building, floor) values ('LT-' || lpad(i::text, 2, '0'), 'Load', '1')
    returning id into v_room;
    -- 700 slots in total: 10 rooms x 30 + 10 rooms x 23 + 10 rooms x 17 = 700
    insert into public.session_rooms (session_id, room_id, max_invigilators)
    values (v_session, v_room, case when i <= 10 then 30 when i <= 20 then 23 else 17 end);
  end loop;

  insert into public.schedule (employee_id, employee_name, department, exam_date, session_label)
  select 'LT' || lpad(g::text, 4, '0'), 'Load Test ' || g, 'DEPT' || (g % 12), current_date, 'FN'
    from generate_series(1, 600) g;
end;
$$;

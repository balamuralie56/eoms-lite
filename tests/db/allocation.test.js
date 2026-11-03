'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { World, buildTemplate, dropTemplate, replayViolations, integrityProblems } = require('./harness');

before(buildTemplate);
after(dropTemplate);

async function withWorld(fn) {
  const w = await World.create();
  try { await fn(w); } finally { await w.close(); }
}

async function checkinAll(w, anon, ids) {
  const out = [];
  for (const id of ids) out.push(await w.checkin(anon, id));
  return out;
}

test('first invigilator is allocated in EVERY active room before any second-round allocation', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2, 2, 2, 2]);
    const ids = await w.scheduleMany('E', 8, s);
    const anon = await w.as('anon');

    const first4 = await checkinAll(w, anon, ids.slice(0, 4));
    assert.ok(first4.every((r) => r.code === 'ALLOCATED' && r.round === 1));
    assert.deepEqual(await w.counts(s), { R1: 1, R2: 1, R3: 1, R4: 1 });
    assert.equal(new Set(first4.map((r) => r.room_code)).size, 4, 'four distinct rooms');

    const next4 = await checkinAll(w, anon, ids.slice(4));
    assert.ok(next4.every((r) => r.round === 2));
    assert.deepEqual(await w.counts(s), { R1: 2, R2: 2, R3: 2, R4: 2 });
    assert.deepEqual(await replayViolations(w, s), []);
  });
});

test('third and subsequent rounds', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [3, 3, 3]);
    const ids = await w.scheduleMany('E', 9, s);
    const anon = await w.as('anon');
    const res = await checkinAll(w, anon, ids);
    assert.deepEqual(res.map((r) => r.round), [1, 1, 1, 2, 2, 2, 3, 3, 3]);
    assert.deepEqual(await w.counts(s), { R1: 3, R2: 3, R3: 3 });
    assert.deepEqual(await replayViolations(w, s), []);
  });
});

test('rooms with different capacities', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [1, 3, 2]);
    const ids = await w.scheduleMany('E', 7, s);
    const anon = await w.as('anon');
    const res = await checkinAll(w, anon, ids);
    // 6 slots in total; the 7th must be ROOMS_FULL
    assert.equal(res.filter((r) => r.code === 'ALLOCATED').length, 6);
    assert.equal(res[6].code, 'ROOMS_FULL');
    assert.deepEqual(await w.counts(s), { R1: 1, R2: 3, R3: 2 });
    assert.equal(new Set(res.slice(0, 3).map((r) => r.room_code)).size, 3, 'round 1 covers all rooms');
    assert.deepEqual(await replayViolations(w, s), []);
  });
});

test('inactive rooms (room-level and session-room-level) never receive allocations', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const rA = await w.room('ACTIVE');
    const rInactiveRoom = await w.room('DEAD-ROOM', { active: false });
    const rInactiveLink = await w.room('DEAD-LINK');
    await w.sessionRoom(s, rA, 5);
    await w.sessionRoom(s, rInactiveRoom, 5);
    await w.sessionRoom(s, rInactiveLink, 5, { active: false });
    const ids = await w.scheduleMany('E', 5, s);
    const anon = await w.as('anon');
    const res = await checkinAll(w, anon, ids);
    assert.ok(res.every((r) => r.code === 'ALLOCATED' && r.room_code === 'ACTIVE'));
    assert.deepEqual(await integrityProblems(w), []);
  });
});

test('full rooms are excluded; when all rooms are full the result is ROOMS_FULL and nothing is over-allocated', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [1, 1]);
    const ids = await w.scheduleMany('E', 4, s);
    const anon = await w.as('anon');
    const res = await checkinAll(w, anon, ids);
    assert.deepEqual(res.map((r) => r.code), ['ALLOCATED', 'ALLOCATED', 'ROOMS_FULL', 'ROOMS_FULL']);
    assert.match(res[2].message, /contact the examination cell/i);
    assert.deepEqual(await w.counts(s), { R1: 1, R2: 1 });
    assert.equal((await w.one('select count(*)::int c from allocations where employee_id = $1', [ids[2]])).c, 0);
    assert.deepEqual(await integrityProblems(w), []);
  });
});

test('unscheduled employee is rejected and nothing is written', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('E1', s);
    const anon = await w.as('anon');
    const r = await w.checkin(anon, 'NOBODY');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_SCHEDULED');
    assert.equal(r.employee_name, undefined, 'must not leak employee data');
    assert.equal((await w.one('select count(*)::int c from allocations')).c, 0);
  });
});

test('employee IDs are normalised (trim + uppercase)', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('EMP7', s);
    const anon = await w.as('anon');
    const r = await w.checkin(anon, '  emp7 ');
    assert.equal(r.code, 'ALLOCATED');
    assert.equal(r.employee_id, 'EMP7');
    assert.equal((await w.checkin(anon, 'Emp7')).code, 'ALREADY_ALLOCATED');
  });
});

test('malformed IDs are rejected as INVALID_ID', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [1]);
    const anon = await w.as('anon');
    for (const bad of ['', '   ', null, "E1'; drop table schedule;--", 'A'.repeat(51), 'E 1']) {
      const r = await w.checkin(anon, bad);
      assert.equal(r.code, 'INVALID_ID', JSON.stringify(bad));
    }
    assert.equal((await w.one('select count(*)::int c from schedule')).c, 0);
  });
});

test('FN and AN are independent: one allocation per session for the same employee on the same date', async () => {
  await withWorld(async (w) => {
    const fn = await w.session({ label: 'FN', opens: -30, closes: 30 });
    await w.rooms(fn, [2], 'F');
    const an = await w.session({ label: 'AN', opens: 60, closes: 120 }); // future, no overlap
    await w.rooms(an, [2], 'A');
    await w.schedule('BOTH', fn);
    await w.schedule('BOTH', an);
    await w.schedule('ONLYFN', fn);
    const anon = await w.as('anon');

    const r1 = await w.checkin(anon, 'BOTH');
    assert.equal(r1.code, 'ALLOCATED');
    assert.equal(r1.session, 'FN');
    assert.match(r1.room_code, /^F/);

    // FN window passes (deactivate FN so AN can be moved into the present without overlap)
    await w.q('update exam_sessions set is_active = false where id = $1', [fn.id]);
    await w.q(`update exam_sessions set checkin_opens_at = now() - interval '10 minutes',
                                         checkin_closes_at = now() + interval '50 minutes' where id = $1`, [an.id]);
    const r2 = await w.checkin(anon, 'BOTH');
    assert.equal(r2.code, 'ALLOCATED', 'AN allocation is separate from the FN one');
    assert.equal(r2.session, 'AN');
    assert.match(r2.room_code, /^A/);

    const active = await w.q(`select s.session_label from allocations a join exam_sessions s on s.id = a.session_id
                               where a.employee_id = 'BOTH' and a.released_at is null order by 1`);
    assert.deepEqual(active.map((x) => x.session_label), ['AN', 'FN']);

    assert.equal((await w.checkin(anon, 'ONLYFN')).code, 'NOT_SCHEDULED', 'scheduled for FN only, AN is open');
  });
});

test('no active session: rejected, never falls back to the most recent session', async () => {
  await withWorld(async (w) => {
    const anon = await w.as('anon');
    assert.equal((await w.checkin(anon, 'E1')).code, 'NO_ACTIVE_SESSION', 'no sessions at all');

    const past = await w.session({ label: 'FN', opens: -180, closes: -120 });
    await w.rooms(past, [2]);
    await w.schedule('E1', past);
    const future = await w.session({ label: 'AN', opens: 120, closes: 180 });
    await w.rooms(future, [2], 'X');
    await w.schedule('E1', future);
    const r = await w.checkin(anon, 'E1');
    assert.equal(r.code, 'NO_ACTIVE_SESSION');
    assert.equal((await w.one('select count(*)::int c from allocations')).c, 0);
    const status = await anon.query('select public.get_checkin_status() as s');
    assert.equal(status.rows[0].s.state, 'CLOSED');
  });
});

test('an inactive session is closed for check-in, and opens again when re-activated', async () => {
  await withWorld(async (w) => {
    const s = await w.session({ opens: -30, closes: 30, active: false });
    await w.rooms(s, [2]);
    await w.schedule('E1', s);
    const anon = await w.as('anon');
    assert.equal((await w.checkin(anon, 'E1')).code, 'NO_ACTIVE_SESSION', 'inactive session');
    await w.q('update exam_sessions set is_active = true where id = $1', [s.id]);
    assert.equal((await w.checkin(anon, 'E1')).code, 'ALLOCATED');
  });
});

test('overlapping ACTIVE session windows are rejected by the database; adjacent and inactive ones are fine', async () => {
  await withWorld(async (w) => {
    await w.session({ label: 'FN', date: '2026-11-03', opens: 0, closes: 60 });
    await assert.rejects(
      w.session({ label: 'AN', date: '2026-11-03', opens: 30, closes: 90 }),
      (e) => e.code === '23P01', 'overlap must violate the exclusion constraint');
    await w.session({ label: 'AN', date: '2026-11-03', opens: 60, closes: 120 });           // adjacent: ok
    await w.session({ label: 'FN', date: '2026-11-04', opens: 10, closes: 50, active: false }); // inactive overlap: ok
    await assert.rejects(
      w.q(`update exam_sessions set is_active = true where exam_date = '2026-11-04'`),
      (e) => e.code === '23P01', 're-activating into an overlap is rejected too');
    await assert.rejects(
      w.session({ label: 'FN', date: '2026-11-03', opens: 200, closes: 260 }),
      (e) => e.code === '23505', 'same date+label twice');
  });
});

test('sequential duplicate submissions return the same allocation (never re-randomised)', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [5, 5, 5, 5, 5, 5, 5, 5]);
    const ids = await w.scheduleMany('E', 3, s);
    const anon = await w.as('anon');
    const first = await w.checkin(anon, ids[0]);
    assert.equal(first.code, 'ALLOCATED');
    for (let i = 0; i < 25; i++) {
      const again = await w.checkin(anon, ids[0]);
      assert.equal(again.code, 'ALREADY_ALLOCATED');
      assert.equal(again.room_code, first.room_code);
      assert.equal(again.reference, first.reference);
      assert.equal(again.allocated_at, first.allocated_at);
    }
    assert.equal((await w.one('select count(*)::int c from allocations')).c, 1);
  });
});

test('admin correction is returned on re-submission', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const [r1, r2] = await w.rooms(s, [1, 1]);
    await w.schedule('E1', s);
    const adminId = await w.admin();
    const adm = await w.as('authenticated', { sub: adminId });
    const anon = await w.as('anon');

    const first = await w.checkin(anon, 'E1');
    const target = first.room_code === 'R1' ? r2 : r1;
    const targetCode = first.room_code === 'R1' ? 'R2' : 'R1';
    const old = await w.one(`select id from allocations where employee_id = 'E1'`);

    const res = await adm.query('select public.admin_reassign($1, $2, $3) as r', [old.id, target.id, 'Room change requested by HOD']);
    assert.equal(res.rows[0].r.ok, true);

    const again = await w.checkin(anon, 'E1');
    assert.equal(again.code, 'ALREADY_ALLOCATED');
    assert.equal(again.room_code, targetCode);

    const rows = await w.q(`select source, released_at, supersedes_allocation_id, created_by from allocations
                             where employee_id = 'E1' order by seq`);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].released_at, null);
    assert.equal(rows[1].source, 'admin_correction');
    assert.equal(rows[1].supersedes_allocation_id, old.id);
    assert.equal(rows[1].created_by, adminId);
    assert.deepEqual(await integrityProblems(w), []);
  });
});

test('correction cannot go to a full or inactive room, nor outside the session', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const [r1, r2] = await w.rooms(s, [1, 1]);
    const dead = await w.sessionRoom(s, await w.room('DEAD', { active: false }), 3);
    const other = await w.session({ label: 'AN', opens: 100, closes: 160 });
    const [foreign] = await w.rooms(other, [3], 'O');
    await w.scheduleMany('E', 2, s);
    const adm = await w.as('authenticated', { sub: await w.admin() });
    const anon = await w.as('anon');
    await w.checkin(anon, 'E0001');
    await w.checkin(anon, 'E0002');
    const a1 = await w.one(`select a.id, a.session_room_id from allocations a where employee_id = 'E0001'`);
    const full = a1.session_room_id === r1.id ? r2 : r1;     // the other room is full (1/1)
    for (const t of [full.id, dead.id, foreign.id]) {
      await assert.rejects(adm.query('select public.admin_reassign($1, $2, $3)', [a1.id, t, 'testing']));
    }
    assert.deepEqual(await integrityProblems(w), []);
  });
});

test('a released allocation is not silently recreated: re-entry needs explicit admin authorization', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2, 2]);
    await w.schedule('E1', s);
    const adminId = await w.admin();
    const adm = await w.as('authenticated', { sub: adminId });
    const anon = await w.as('anon');

    assert.equal((await w.checkin(anon, 'E1')).code, 'ALLOCATED');
    const a = await w.one(`select id from allocations where employee_id = 'E1'`);
    await adm.query('select public.admin_release($1, $2)', [a.id, 'Employee reported sick']);

    for (let i = 0; i < 3; i++) {
      const r = await w.checkin(anon, 'E1');
      assert.equal(r.ok, false);
      assert.equal(r.code, 'REENTRY_REQUIRES_ADMIN');
    }
    assert.equal((await w.one(`select count(*)::int c from allocations where released_at is null`)).c, 0);

    // late authorization is the wrong tool for a released allocation
    await assert.rejects(adm.query('select public.admin_authorize_late($1, $2, $3)', ['E1', s.id, 'wrong kind']));

    const auth = await adm.query('select public.admin_authorize_reentry($1, $2, $3) as r', ['E1', s.id, 'Recovered, back on duty']);
    assert.equal(auth.rows[0].r.ok, true);

    const back = await w.checkin(anon, 'E1');
    assert.equal(back.code, 'ALLOCATED');
    const row = await w.one(`select source from allocations where employee_id = 'E1' and released_at is null`);
    assert.equal(row.source, 'admin_reentry');
    const perm = await w.one(`select consumed_at, consumed_allocation_id from admin_authorizations where id = $1`, [auth.rows[0].r.authorization_id]);
    assert.notEqual(perm.consumed_at, null);
    assert.equal((await w.checkin(anon, 'E1')).code, 'ALREADY_ALLOCATED');
  });
});

test('late check-in is rejected without authorization', async () => {
  await withWorld(async (w) => {
    const s = await w.session({ opens: -120, closes: -60 });
    await w.rooms(s, [2]);
    await w.schedule('LATE1', s);
    const anon = await w.as('anon');
    const r = await w.checkin(anon, 'LATE1');
    assert.equal(r.code, 'NO_ACTIVE_SESSION');
    assert.equal((await w.one('select count(*)::int c from allocations')).c, 0);
  });
});

test('late check-in is accepted with a valid admin authorization and reason; audited', async () => {
  await withWorld(async (w) => {
    const s = await w.session({ opens: -120, closes: -60 });
    await w.rooms(s, [2]);
    await w.schedule('LATE1', s);
    const adminId = await w.admin();
    const adm = await w.as('authenticated', { sub: adminId });
    const anon = await w.as('anon');

    await assert.rejects(adm.query('select public.admin_authorize_late($1,$2,$3)', ['LATE1', s.id, ' ']), /reason/);
    const auth = await adm.query('select public.admin_authorize_late($1,$2,$3) as r', [' late1 ', s.id, 'Train delay, approved by controller']);
    assert.equal(auth.rows[0].r.ok, true);

    const r = await w.checkin(anon, 'LATE1');
    assert.equal(r.code, 'ALLOCATED');
    const row = await w.one(`select source, created_by from allocations where employee_id = 'LATE1'`);
    assert.equal(row.source, 'admin_late');
    assert.equal(row.created_by, adminId);

    const audit = await w.q(`select actor, actor_user_id, after from audit_log where action = 'authorization.late'`);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, 'admin:' + adminId);
    assert.equal(audit[0].actor_user_id, adminId);
    assert.equal(audit[0].after.reason, 'Train delay, approved by controller');
  });
});

test('late authorization does not bypass schedule validation or capacity', async () => {
  await withWorld(async (w) => {
    const s = await w.session({ opens: -120, closes: -60 });
    await w.rooms(s, [1]);
    await w.schedule('L1', s);
    await w.schedule('L2', s);
    const adm = await w.as('authenticated', { sub: await w.admin() });
    const anon = await w.as('anon');

    await assert.rejects(adm.query('select public.admin_authorize_late($1,$2,$3)', ['GHOST', s.id, 'not on the roster']), /not scheduled/);

    await adm.query('select public.admin_authorize_late($1,$2,$3)', ['L1', s.id, 'delayed']);
    await adm.query('select public.admin_authorize_late($1,$2,$3)', ['L2', s.id, 'delayed']);
    assert.equal((await w.checkin(anon, 'L1')).code, 'ALLOCATED');
    const full = await w.checkin(anon, 'L2');
    assert.equal(full.code, 'ROOMS_FULL', 'capacity still enforced');
    const permit = await w.one(`select consumed_at from admin_authorizations where employee_id = 'L2'`);
    assert.equal(permit.consumed_at, null, 'permit is not consumed by a failed allocation');
    assert.deepEqual(await integrityProblems(w), []);
  });
});

test('a late permit session is served first; once consumed, the currently open session is served', async () => {
  await withWorld(async (w) => {
    const closed = await w.session({ label: 'FN', opens: -300, closes: -240 });
    await w.rooms(closed, [1], 'C');
    const open = await w.session({ label: 'AN', opens: -30, closes: 30 });
    await w.rooms(open, [1], 'O');
    await w.schedule('E1', closed);
    await w.schedule('E1', open);
    const adm = await w.as('authenticated', { sub: await w.admin() });
    const anon = await w.as('anon');
    await adm.query('select public.admin_authorize_late($1,$2,$3)', ['E1', closed.id, 'late for FN']);
    const r1 = await w.checkin(anon, 'E1');   // permit session is served first
    assert.equal(r1.code, 'ALLOCATED');
    assert.equal(r1.session, 'FN');
    const r2 = await w.checkin(anon, 'E1');   // permit consumed -> the open AN session is served
    assert.equal(r2.code, 'ALLOCATED');
    assert.equal(r2.session, 'AN');
  });
});

test('flagged employees need administrator verification; employees cannot clear their own flag', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('F1', s);
    await w.schedule('F2', s);
    const adm = await w.as('authenticated', { sub: await w.admin() });
    const anon = await w.as('anon');

    const f1 = (await adm.query('select public.admin_flag_employee($1,$2,$3) as r', ['F1', s.id, 'ID mismatch at desk'])).rows[0].r;
    const f2 = (await adm.query('select public.admin_flag_employee($1,$2,$3) as r', ['F2', s.id, 'duplicate claim'])).rows[0].r;

    const r = await w.checkin(anon, 'F1');
    assert.equal(r.code, 'VERIFICATION_REQUIRED');
    assert.equal(r.reference, f1.reference);
    assert.equal((await w.one('select count(*)::int c from allocations')).c, 0);

    await assert.rejects(anon.query('select public.admin_resolve_flag($1,$2,$3)', [f1.flag_id, 'cleared', 'self clear']), (e) => e.code === '42501');

    await adm.query('select public.admin_resolve_flag($1,$2,$3)', [f1.flag_id, 'cleared', 'Verified ID card at desk']);
    assert.equal((await w.checkin(anon, 'F1')).code, 'ALLOCATED');

    await adm.query('select public.admin_resolve_flag($1,$2,$3)', [f2.flag_id, 'blocked', 'Not permitted to invigilate']);
    assert.equal((await w.checkin(anon, 'F2')).code, 'VERIFICATION_REQUIRED');
  });
});

test('audit records are written for privileged operations and carry before/after', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const [r1, r2] = await w.rooms(s, [2, 2]);
    await w.scheduleMany('E', 3, s);
    const adminId = await w.admin();
    const adm = await w.as('authenticated', { sub: adminId });
    const anon = await w.as('anon');
    await w.checkin(anon, 'E0001');
    const a = await w.one(`select id, session_room_id from allocations where employee_id = 'E0001'`);
    const other = a.session_room_id === r1.id ? r2 : r1;

    await adm.query('select public.admin_reassign($1,$2,$3)', [a.id, other.id, 'balance']);
    const a2 = await w.one(`select id from allocations where employee_id = 'E0001' and released_at is null`);
    await adm.query('select public.admin_release($1,$2)', [a2.id, 'sick leave']);
    const fl = (await adm.query('select public.admin_flag_employee($1,$2,$3) as r', ['E0002', s.id, 'check id'])).rows[0].r;
    await adm.query('select public.admin_resolve_flag($1,$2,$3)', [fl.flag_id, 'cleared', 'verified at desk']);
    const au = (await adm.query('select public.admin_authorize_reentry($1,$2,$3) as r', ['E0001', s.id, 'ok again'])).rows[0].r;
    await adm.query('select public.admin_revoke_authorization($1,$2)', [au.authorization_id, 'changed mind']);

    const actions = (await w.q('select action from audit_log order by id')).map((x) => x.action);
    assert.deepEqual(actions, [
      'allocation.create', 'allocation.reassign', 'allocation.release',
      'flag.create', 'flag.resolve', 'authorization.reentry', 'authorization.revoke',
    ]);
    const rel = await w.one(`select actor, before, after from audit_log where action = 'allocation.release'`);
    assert.equal(rel.actor, 'admin:' + adminId);
    assert.equal(rel.before.released_at, null);
    assert.notEqual(rel.after.released_at, null);
    assert.equal(rel.after.release_reason, 'sick leave');
  });
});

test('abuse throttle: repeated failed lookups from one client IP are rate limited (other IPs unaffected)', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('REAL', s);
    await w.q(`update app_settings set int_value = 3 where key = 'throttle_max_failures'`);
    const a = await w.as('anon', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    const b = await w.as('anon', { headers: { 'x-forwarded-for': '203.0.113.10' } });
    for (let i = 0; i < 3; i++) assert.equal((await w.checkin(a, 'GHOST' + i)).code, 'NOT_SCHEDULED');
    assert.equal((await w.checkin(a, 'REAL')).code, 'RATE_LIMITED');
    assert.equal((await w.checkin(b, 'REAL')).code, 'ALLOCATED');
    const stored = await w.one(`select ip_hash from check_attempts limit 1`);
    assert.match(stored.ip_hash, /^[0-9a-f]{64}$/, 'only a hash of the IP is stored');
  });
});

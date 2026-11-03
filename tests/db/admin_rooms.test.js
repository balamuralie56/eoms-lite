'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { World, buildTemplate, dropTemplate, integrityProblems } = require('./harness');

before(buildTemplate);
after(dropTemplate);

async function withWorld(fn) {
  const w = await World.create();
  try { await fn(w); } finally { await w.close(); }
}

const rejects = (p, code, re) =>
  assert.rejects(p, (e) => (code ? e.code === code : true) && (re ? re.test(e.message) : true), `${code} ${re}`);

test('create room: code normalised, duplicates rejected case-insensitively, validated, audited', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const r = await w.rpc(adm, 'admin_create_room', '  a101 ', 'Main Block', '1');
    assert.equal(r.room.room_code, 'A101');
    assert.equal(r.room.building, 'Main Block');
    await rejects(w.rpc(adm, 'admin_create_room', 'A101'), '23505', /already exists/);
    await rejects(w.rpc(adm, 'admin_create_room', 'a101'), '23505', /already exists/);
    await rejects(w.rpc(adm, 'admin_create_room', '   '), '22023', /required/);
    await rejects(w.rpc(adm, 'admin_create_room', 'X'.repeat(51)), '22023', /50/);
    await rejects(w.rpc(adm, 'admin_create_room', 'B1', 'x'.repeat(101)), '22023', /too long/);
    assert.equal((await w.one('select count(*)::int c from rooms')).c, 1);
    const a = await w.one(`select actor, after from audit_log where action = 'room.create'`);
    assert.equal(a.actor, 'admin:' + adm.adminId);
    assert.equal(a.after.room_code, 'A101');
  });
});

test('update room: rename, clear fields, duplicate code rejected; confirmation needed when slips already show it', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const anon = await w.as('anon');
    const a = (await w.rpc(adm, 'admin_create_room', 'A1', 'Old', '2')).room;
    const b = (await w.rpc(adm, 'admin_create_room', 'B1')).room;
    await rejects(w.rpc(adm, 'admin_update_room', b.id, 'a1'), '23505', /already exists/);
    const u = await w.rpc(adm, 'admin_update_room', a.id, 'A2', 'New', '');
    assert.equal(u.room.room_code, 'A2');
    assert.equal(u.room.building, 'New');
    assert.equal(u.room.floor, null, 'empty string clears');
    const au = await w.one(`select before, after from audit_log where action = 'room.update' order by id desc limit 1`);
    assert.equal(au.before.room_code, 'A1');
    assert.equal(au.after.room_code, 'A2');

    // with an active allocation, changing displayed details needs p_confirm
    const s = await w.session({ opens: -30, closes: 30 });
    await w.rpc(adm, 'admin_assign_room_to_session', s.id, a.id, 1);
    await w.schedule('E1', s);
    assert.equal((await w.checkin(anon, 'E1')).room_code, 'A2');
    await rejects(w.rpc(adm, 'admin_update_room', a.id, 'A3'), '22023', /active allocations.*p_confirm/);
    await rejects(w.rpc(adm, 'admin_update_room', a.id, null, 'Newer'), '22023', /p_confirm/);
    const ok = await w.rpc(adm, 'admin_update_room', a.id, 'A3', null, null, true);
    assert.equal(ok.room.room_code, 'A3');
    assert.equal((await w.checkin(anon, 'E1')).room_code, 'A3', 'the existing allocation shows the corrected code');
  });
});

test('room activation: inactive rooms are excluded from allocation; deactivating a room in use needs confirmation', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const anon = await w.as('anon');
    const s = await w.session({ opens: -30, closes: 30 });
    const r1 = (await w.rpc(adm, 'admin_create_room', 'R1')).room;
    const r2 = (await w.rpc(adm, 'admin_create_room', 'R2')).room;
    await w.rpc(adm, 'admin_assign_room_to_session', s.id, r1.id, 5);
    await w.rpc(adm, 'admin_assign_room_to_session', s.id, r2.id, 5);
    const ids = await w.scheduleMany('E', 6, s);

    await w.rpc(adm, 'admin_set_room_active', r2.id, false, 'under maintenance');
    for (const id of ids.slice(0, 3)) assert.equal((await w.checkin(anon, id)).room_code, 'R1');

    await rejects(w.rpc(adm, 'admin_set_room_active', r1.id, false, 'flooded'), '22023', /3 active allocations.*p_confirm/);
    const off = await w.rpc(adm, 'admin_set_room_active', r1.id, false, 'flooded', true);
    assert.equal(off.active_allocations, 3);
    assert.equal((await w.checkin(anon, ids[3])).code, 'ROOMS_FULL', 'no active room is left');
    assert.equal((await w.one(`select count(*)::int c from allocations where released_at is null`)).c, 3, 'existing allocations untouched');

    await w.rpc(adm, 'admin_set_room_active', r2.id, true, 'repaired');
    assert.equal((await w.checkin(anon, ids[3])).room_code, 'R2');
    const au = await w.one(`select before, after from audit_log where action = 'room.deactivate' order by id desc limit 1`);
    assert.equal(au.before.is_active, true);
    assert.equal(au.after.is_active, false);
    assert.equal(au.after.reason, 'flooded');
    assert.equal((await w.rpc(adm, 'admin_set_room_active', r2.id, true, 'already active')).unchanged, true);
    // allocations that pre-date a confirmed deactivation intentionally stay; nothing else may be wrong
    assert.deepEqual((await integrityProblems(w)).filter((p) => !p.activeInInactiveRoom), []);
  });
});

test('assign rooms to sessions with separate invigilator capacity per session', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const fn = await w.session({ label: 'FN', date: '2026-11-03', opens: 0, closes: 60 });
    const an = await w.session({ label: 'AN', date: '2026-11-03', opens: 60, closes: 120 });
    const room = (await w.rpc(adm, 'admin_create_room', 'HALL', 'Main', '0')).room;

    const x = await w.rpc(adm, 'admin_assign_room_to_session', fn.id, room.id, 4);
    const y = await w.rpc(adm, 'admin_assign_room_to_session', an.id, room.id, 2);
    assert.equal(x.session_room.max_invigilators, 4);
    assert.equal(y.session_room.max_invigilators, 2, 'capacity is per session, same room');
    await rejects(w.rpc(adm, 'admin_assign_room_to_session', fn.id, room.id, 3), '23505', /already assigned/);
    for (const bad of [0, -1, 101, null]) {
      await rejects(w.rpc(adm, 'admin_assign_room_to_session', an.id, room.id, bad), '22023', /between 1 and 100/);
    }
    await rejects(w.rpc(adm, 'admin_assign_room_to_session', '00000000-0000-0000-0000-000000000000', room.id, 2), '22023', /session not found/);
    await rejects(w.rpc(adm, 'admin_assign_room_to_session', an.id, '00000000-0000-0000-0000-000000000000', 2), '22023', /room not found/);
    // no student-seating notion anywhere: rooms has no capacity column
    const cols = await w.q(`select column_name from information_schema.columns where table_name = 'rooms'`);
    assert.ok(!cols.map((c) => c.column_name).includes('capacity'));
    const a = await w.one(`select after from audit_log where action = 'session_room.assign' order by id limit 1`);
    assert.equal(a.after.max_invigilators, 4);
  });
});

test('capacity updates: increase works, reduction below the active count is rejected (RPC and database), new capacity is enforced', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const anon = await w.as('anon');
    const s = await w.session({ opens: -30, closes: 30 });
    const room = (await w.rpc(adm, 'admin_create_room', 'R1')).room;
    const sr = (await w.rpc(adm, 'admin_assign_room_to_session', s.id, room.id, 3)).session_room;
    const ids = await w.scheduleMany('E', 6, s);
    for (const id of ids.slice(0, 3)) assert.equal((await w.checkin(anon, id)).code, 'ALLOCATED');
    assert.equal((await w.checkin(anon, ids[3])).code, 'ROOMS_FULL');

    await rejects(w.rpc(adm, 'admin_update_session_room', sr.id, 2), '23514', /below|reduce capacity to 2.*3 active/);
    // the database refuses it even when bypassing the RPC
    await rejects(w.q(`update session_rooms set max_invigilators = 1 where id = $1`, [sr.id]), '23514', /below the 3 active/);
    await rejects(w.rpc(adm, 'admin_update_session_room', sr.id, 0), '22023', /between 1 and 100/);

    const up = await w.rpc(adm, 'admin_update_session_room', sr.id, 5);
    assert.equal(up.session_room.max_invigilators, 5);
    assert.equal((await w.checkin(anon, ids[3])).code, 'ALLOCATED');
    assert.equal((await w.checkin(anon, ids[4])).code, 'ALLOCATED');
    assert.equal((await w.checkin(anon, ids[5])).code, 'ROOMS_FULL');

    const eq = await w.rpc(adm, 'admin_update_session_room', sr.id, 5);                // equal to active count: fine
    assert.equal(eq.ok, true);
    const au = await w.one(`select before, after from audit_log where action = 'session_room.update_capacity' order by id limit 1`);
    assert.equal(au.before.max_invigilators, 3);
    assert.equal(au.after.max_invigilators, 5);
    assert.deepEqual(await integrityProblems(w), []);
  });
});

test('capacity reduction after a release succeeds (released allocations do not count)', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const anon = await w.as('anon');
    const s = await w.session({ opens: -30, closes: 30 });
    const room = (await w.rpc(adm, 'admin_create_room', 'R1')).room;
    const sr = (await w.rpc(adm, 'admin_assign_room_to_session', s.id, room.id, 3)).session_room;
    for (const id of await w.scheduleMany('E', 3, s)) await w.checkin(anon, id);
    const first = await w.one(`select id from allocations order by seq limit 1`);
    await w.rpc(adm, 'admin_release', first.id, 'sick leave');
    const down = await w.rpc(adm, 'admin_update_session_room', sr.id, 2);
    assert.equal(down.session_room.max_invigilators, 2);
  });
});

test('session-specific room activation: inactive links never receive allocations; deactivation in use needs confirmation', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const anon = await w.as('anon');
    const s = await w.session({ opens: -30, closes: 30 });
    const r1 = (await w.rpc(adm, 'admin_create_room', 'R1')).room;
    const r2 = (await w.rpc(adm, 'admin_create_room', 'R2')).room;
    const sr1 = (await w.rpc(adm, 'admin_assign_room_to_session', s.id, r1.id, 5)).session_room;
    const sr2 = (await w.rpc(adm, 'admin_assign_room_to_session', s.id, r2.id, 5)).session_room;
    const ids = await w.scheduleMany('E', 5, s);

    await w.rpc(adm, 'admin_set_session_room_active', sr2.id, false, 'not needed for this paper');
    for (const id of ids.slice(0, 2)) assert.equal((await w.checkin(anon, id)).room_code, 'R1');

    await rejects(w.rpc(adm, 'admin_set_session_room_active', sr1.id, false, 'closing it'), '22023', /2 active allocations.*p_confirm/);
    await w.rpc(adm, 'admin_set_session_room_active', sr1.id, false, 'closing it', true);
    assert.equal((await w.checkin(anon, ids[2])).code, 'ROOMS_FULL');

    await w.rpc(adm, 'admin_set_session_room_active', sr2.id, true, 'needed again');
    assert.equal((await w.checkin(anon, ids[2])).room_code, 'R2');
    const au = await w.one(`select before, after from audit_log where action = 'session_room.deactivate' order by id limit 1`);
    assert.equal(au.before.is_active, true);
    assert.equal(au.after.is_active, false);
    assert.deepEqual((await integrityProblems(w)).filter((p) => !p.activeInInactiveRoom), []);
  });
});

test('rooms and session rooms with allocation history are never silently deleted', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const anon = await w.as('anon');
    const s = await w.session({ opens: -30, closes: 30 });
    const used = (await w.rpc(adm, 'admin_create_room', 'USED')).room;
    const spare = (await w.rpc(adm, 'admin_create_room', 'SPARE')).room;
    const srUsed = (await w.rpc(adm, 'admin_assign_room_to_session', s.id, used.id, 2)).session_room;
    const srSpare = (await w.rpc(adm, 'admin_assign_room_to_session', s.id, spare.id, 2)).session_room;
    await w.schedule('E1', s);
    await w.checkin(anon, 'E1');            // lands in one of the rooms; make sure USED has history
    const hist = await w.one(`select session_room_id from allocations`);
    const histSr = hist.session_room_id === srUsed.id ? srUsed : srSpare;
    const idle = histSr === srUsed ? srSpare : srUsed;

    await rejects(w.rpc(adm, 'admin_remove_session_room', histSr.id, 'cleanup'), '23514', /allocation history.*deactivate/);
    // released history still counts as history
    const a = await w.one(`select id from allocations`);
    await w.rpc(adm, 'admin_release', a.id, 'released for test');
    await rejects(w.rpc(adm, 'admin_remove_session_room', histSr.id, 'cleanup'), '23514', /allocation history/);
    // the database refuses to delete the room or the link underneath
    const roomOfHist = histSr === srUsed ? used : spare;
    await rejects(w.q('delete from rooms where id = $1', [roomOfHist.id]), '23503');
    await rejects(w.q('delete from session_rooms where id = $1', [histSr.id]), '23503');

    const gone = await w.rpc(adm, 'admin_remove_session_room', idle.id, 'wrong room added');
    assert.equal(gone.ok, true);
    assert.equal((await w.one('select count(*)::int c from session_rooms')).c, 1);
    const au = await w.one(`select before, after from audit_log where action = 'session_room.remove'`);
    assert.equal(au.before.id, idle.id);
    assert.equal(au.after.reason, 'wrong room added');
  });
});

test('direct SQL cannot move a session room to another session/room', async () => {
  await withWorld(async (w) => {
    const a = await w.session({ label: 'FN', opens: 0, closes: 60 });
    const b = await w.session({ label: 'AN', opens: 60, closes: 120 });
    const [sr] = await w.rooms(a, [2]);
    await rejects(w.q('update session_rooms set session_id = $1 where id = $2', [b.id, sr.id]), '23514', /immutable/);
  });
});

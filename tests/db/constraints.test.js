'use strict';
// Final-safeguard tests: the database itself rejects violations, independent of the RPC logic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { World, buildTemplate, dropTemplate } = require('./harness');

before(buildTemplate);
after(dropTemplate);

async function withWorld(fn) {
  const w = await World.create();
  try { await fn(w); } finally { await w.close(); }
}

const insertAlloc = (w, s, sr, emp, extra = '') =>
  w.q(`insert into allocations (session_id, session_room_id, employee_id, round, source) values ($1, $2, $3, 1, 'normal') ${extra}`,
      [s.id, sr.id, emp]);

test('partial unique index: one ACTIVE allocation per employee per session (released rows do not count)', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const [r1, r2] = await w.rooms(s, [5, 5]);
    await insertAlloc(w, s, r1, 'E1');
    await assert.rejects(insertAlloc(w, s, r2, 'E1'), (e) => e.code === '23505' && /one_active/.test(e.constraint));
    await w.q(`update allocations set released_at = now(), release_reason = 'x' where employee_id = 'E1'`);
    await insertAlloc(w, s, r2, 'E1');   // allowed once the earlier one is released
    assert.equal((await w.one('select count(*)::int c from allocations')).c, 2);
  });
});

test('capacity trigger: direct inserts cannot exceed max_invigilators', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const [r1] = await w.rooms(s, [2]);
    await insertAlloc(w, s, r1, 'E1');
    await insertAlloc(w, s, r1, 'E2');
    await assert.rejects(insertAlloc(w, s, r1, 'E3'), (e) => e.code === '23514' && /capacity/.test(e.message));
  });
});

test('trigger rejects allocations into inactive rooms / inactive session rooms / inactive sessions', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const deadRoom = await w.sessionRoom(s, await w.room('D1', { active: false }), 3);
    const deadLink = await w.sessionRoom(s, await w.room('D2'), 3, { active: false });
    await assert.rejects(insertAlloc(w, s, deadRoom, 'E1'), (e) => e.code === '23514');
    await assert.rejects(insertAlloc(w, s, deadLink, 'E1'), (e) => e.code === '23514');
    const s2 = await w.session({ label: 'AN', opens: 100, closes: 160, active: false });
    const [r] = await w.rooms(s2, [3], 'Z');
    await assert.rejects(insertAlloc(w, s2, r, 'E1'), (e) => e.code === '23514');
  });
});

test('composite FK: an allocation cannot point at a room of another session', async () => {
  await withWorld(async (w) => {
    const a = await w.session({ label: 'FN' });
    const b = await w.session({ label: 'AN', opens: 100, closes: 160 });
    const [ra] = await w.rooms(a, [2], 'A');
    await assert.rejects(
      w.q(`insert into allocations (session_id, session_room_id, employee_id, round, source) values ($1, $2, 'E1', 1, 'normal')`, [b.id, ra.id]),
      (e) => e.code === '23503');
  });
});

test('allocations are immutable except for one-way release; never deletable', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const [r1, r2] = await w.rooms(s, [5, 5]);
    await insertAlloc(w, s, r1, 'E1');
    await assert.rejects(w.q(`update allocations set session_room_id = $1`, [r2.id]), (e) => e.code === '23514');
    await assert.rejects(w.q(`update allocations set employee_id = 'E9'`), (e) => e.code === '23514');
    await assert.rejects(w.q(`update allocations set released_at = now()`), (e) => e.code === '23514', 'release requires a reason');
    await w.q(`update allocations set released_at = now(), release_reason = 'because'`);
    await assert.rejects(w.q(`update allocations set released_at = null, release_reason = null`), (e) => e.code === '23514', 'no un-release');
    await assert.rejects(w.q(`update allocations set release_reason = 'edited'`), (e) => e.code === '23514');
    await assert.rejects(w.q('delete from allocations'), (e) => e.code === '42501');
    await assert.rejects(w.q('truncate allocations cascade'), (e) => e.code === '42501');
    assert.equal((await w.one('select count(*)::int c from allocations')).c, 1);
  });
});

test('audit_log is append-only even for the table owner', async () => {
  await withWorld(async (w) => {
    await w.q(`insert into audit_log (actor, action) values ('system', 'test')`);
    await assert.rejects(w.q(`update audit_log set action = 'x'`), (e) => e.code === '42501');
    await assert.rejects(w.q('delete from audit_log'), (e) => e.code === '42501');
    await assert.rejects(w.q('truncate audit_log'), (e) => e.code === '42501');
    assert.equal((await w.one('select count(*)::int c from audit_log')).c, 1);
  });
});

test('schedule: unique per employee+date+session, normalised IDs enforced', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.schedule('E1', s);
    await assert.rejects(w.schedule('E1', s), (e) => e.code === '23505');
    await assert.rejects(
      w.q(`insert into schedule (employee_id, employee_name, department, exam_date, session_label)
           values ('lower', 'n', 'd', '2026-11-03', 'FN')`),
      (e) => e.code === '23514');
    await assert.rejects(
      w.q(`insert into schedule (employee_id, employee_name, department, exam_date, session_label)
           values (' PAD ', 'n', 'd', '2026-11-03', 'FN')`),
      (e) => e.code === '23514');
    await assert.rejects(
      w.q(`insert into schedule (employee_id, employee_name, department, exam_date, session_label)
           values ('E2', 'n', 'd', '2026-11-03', 'XX')`),
      (e) => e.code === '23514');
  });
});

test('basic column checks: window order, capacity >= 1, session label', async () => {
  await withWorld(async (w) => {
    await assert.rejects(w.session({ opens: 10, closes: 5 }), (e) => e.code === '23514');
    await assert.rejects(w.session({ label: 'EV' }), (e) => e.code === '23514');
    const s = await w.session();
    await assert.rejects(w.sessionRoom(s, await w.room('Z1'), 0), (e) => e.code === '23514');
  });
});

test('allocation RPCs refuse to run above READ COMMITTED (the locking proof depends on it)', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('E1', s);
    const anon = await w.as('anon');
    await anon.query('begin isolation level repeatable read');
    await assert.rejects(anon.query('select public.checkin($1)', ['E1']), (e) => e.code === '25000');
    await anon.query('rollback');
    assert.equal((await w.checkin(anon, 'E1')).code, 'ALLOCATED');
  });
});

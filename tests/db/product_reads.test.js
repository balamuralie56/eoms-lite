'use strict';
// Migration 0009: read-only admin RPCs (dashboard, monitor, lists, audit viewer, reports).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { World, buildTemplate, dropTemplate } = require('./harness');

before(buildTemplate);
after(dropTemplate);

async function withWorld(fn) {
  const w = await World.create();
  try { await fn(w); } finally { await w.close(); }
}
const rejects = (p, code, re) =>
  assert.rejects(p, (e) => (code ? e.code === code : true) && (re ? re.test(e.message) : true), `${code} ${re}`);

/**
 * Scenario (all numbers asserted below are derived from this):
 *  open session; rooms R1(cap 2) R2(cap 1) R3(cap 3); 10 scheduled employees E01..E10.
 *  E01-E04 check in (round 1 -> one each; E04 goes to the room with space) ... deterministic part: 3 check in,
 *  E04 checked in then released, E05 flagged.
 */
async function scenario(w) {
  const adm = await w.adminClient();
  const anon = await w.as('anon');
  const s = await w.session({ opens: -30, closes: 30 });
  const [r1, r2, r3] = await w.rooms(s, [2, 1, 3]);
  const ids = await w.scheduleMany('E', 10, s);        // E0001..E0010
  for (const id of ids.slice(0, 3)) assert.equal((await w.checkin(anon, id)).code, 'ALLOCATED');
  const e4 = await w.checkin(anon, ids[3]);
  assert.equal(e4.code, 'ALLOCATED');
  const a4 = await w.one(`select id from allocations where employee_id = $1`, [ids[3]]);
  await w.rpc(adm, 'admin_release', a4.id, 'left early');
  const flag = await w.rpc(adm, 'admin_flag_employee', ids[4], s.id, 'ID photo mismatch');
  return { adm, anon, s, r1, r2, r3, ids, flag, a4 };
}

test('overview: every number comes from the database and matches the scenario', async () => {
  await withWorld(async (w) => {
    const { adm, s } = await scenario(w);
    const o = await w.rpc(adm, 'admin_overview');
    assert.equal(o.state, 'OPEN');
    assert.equal(o.session.id, s.id);
    assert.match(o.session.checkin_opens_at_ist, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.deepEqual(o.counts, {
      scheduled: 10, allocated: 3, pending: 7, flagged: 1, released: 1,
      active_rooms: 3, full_rooms: o.counts.full_rooms, total_slots: 6, available_slots: 6 - 3,
    });
    assert.ok(o.counts.full_rooms >= 1, 'R2 (capacity 1) is full');
    assert.equal(o.recent.length, 4, 'recent activity includes the released allocation too');
    assert.equal(o.recent[0].employee_id, 'E0004');
    assert.ok(o.recent[0].released_at);
    assert.equal(o.recent[0].employee_name, 'Name E0004');
    // explicit session id gives the same answer
    assert.deepEqual((await w.rpc(adm, 'admin_overview', s.id)).counts, o.counts);
  });
});

test('overview without sessions reports NONE; falls back to upcoming, then to the latest ended session', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    assert.equal((await w.rpc(adm, 'admin_overview')).state, 'NONE');
    const past = await w.session({ label: 'FN', date: '2026-11-03', opens: -300, closes: -240 });
    assert.equal((await w.rpc(adm, 'admin_overview')).state, 'CLOSED');
    assert.equal((await w.rpc(adm, 'admin_overview')).session.id, past.id);
    const future = await w.session({ label: 'AN', date: '2026-11-03', opens: 600, closes: 700 });
    const o = await w.rpc(adm, 'admin_overview');
    assert.equal(o.state, 'UPCOMING');
    assert.equal(o.session.id, future.id);
    const off = await w.session({ label: 'FN', date: '2026-11-04', opens: -30, closes: 30, active: false });
    assert.equal((await w.rpc(adm, 'admin_overview', off.id)).state, 'INACTIVE');
  });
});

test('room monitor: capacity, allocated, available, status per room; inactive links and rooms are marked', async () => {
  await withWorld(async (w) => {
    const { adm, s, r1, r2, r3 } = await scenario(w);
    const dead = await w.sessionRoom(s, await w.room('R4-DEAD', { active: false }), 2);
    const link = await w.sessionRoom(s, await w.room('R5-LINK'), 2, { active: false });
    const m = await w.rpc(adm, 'admin_room_monitor', s.id);
    const by = Object.fromEntries(m.map((x) => [x.room_code, x]));
    assert.deepEqual(m.map((x) => x.room_code), ['R1', 'R2', 'R3', 'R4-DEAD', 'R5-LINK']);
    assert.equal(by.R2.capacity, 1);
    assert.equal(by.R2.allocated, 1);
    assert.equal(by.R2.available, 0);
    assert.equal(by.R2.status, 'full');
    assert.equal(by.R1.status, 'available');
    assert.equal(by.R1.allocated + by.R3.allocated + by.R2.allocated, 3);
    assert.equal(by['R4-DEAD'].status, 'inactive');
    assert.equal(by['R4-DEAD'].room_active, false);
    assert.equal(by['R5-LINK'].status, 'inactive');
    assert.equal(by['R5-LINK'].link_active, false);
    assert.ok(by.R1.session_room_id === r1.id && by.R2.session_room_id === r2.id && by.R3.session_room_id === r3.id);
    assert.ok(dead && link);
    await rejects(w.rpc(adm, 'admin_room_monitor', null), '22023', /session is required/);
  });
});

test('session and room lists carry live counts', async () => {
  await withWorld(async (w) => {
    const { adm, s } = await scenario(w);
    const sessions = await w.rpc(adm, 'admin_list_sessions');
    assert.equal(sessions.length, 1);
    assert.deepEqual([sessions[0].scheduled, sessions[0].allocated, sessions[0].room_links, sessions[0].total_slots, sessions[0].state],
      [10, 3, 3, 6, 'OPEN']);
    assert.match(sessions[0].opens_ist, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const rooms = await w.rpc(adm, 'admin_list_rooms');
    assert.deepEqual(rooms.map((r) => r.room_code), ['R1', 'R2', 'R3']);
    assert.equal(rooms.reduce((n, r) => n + r.active_allocations, 0), 3);
    assert.ok(rooms.every((r) => r.session_links === 1));
    assert.ok(s);
  });
});

test('schedule list: states, filters, search (wildcards are literal), pagination, total', async () => {
  await withWorld(async (w) => {
    const { adm, s } = await scenario(w);
    const all = await w.rpc(adm, 'admin_list_schedule', s.id, null, null, 4, 0);
    assert.equal(all.total, 10);
    assert.equal(all.rows.length, 4);
    assert.deepEqual(all.rows.map((r) => r.employee_id), ['E0001', 'E0002', 'E0003', 'E0004']);
    const count = async (status) => (await w.rpc(adm, 'admin_list_schedule', s.id, null, status, 50, 0)).total;
    assert.deepEqual([await count('allocated'), await count('released'), await count('flagged'), await count('pending')], [3, 1, 1, 5]);
    const page3 = await w.rpc(adm, 'admin_list_schedule', s.id, null, null, 4, 8);
    assert.deepEqual(page3.rows.map((r) => r.employee_id), ['E0009', 'E0010']);

    assert.equal((await w.rpc(adm, 'admin_list_schedule', s.id, 'name e0007')).total, 1, 'case-insensitive on name');
    assert.equal((await w.rpc(adm, 'admin_list_schedule', s.id, 'CSE')).total, 10, 'department search');
    assert.equal((await w.rpc(adm, 'admin_list_schedule', s.id, '%')).total, 0, '% is literal, not a wildcard');
    assert.equal((await w.rpc(adm, 'admin_list_schedule', s.id, '_')).total, 0, '_ is literal');
    const inj = await w.rpc(adm, 'admin_list_schedule', s.id, "'; drop table schedule; --");
    assert.equal(inj.total, 0);
    assert.equal((await w.one('select count(*)::int c from schedule')).c, 10, 'nothing dropped');
    await rejects(w.rpc(adm, 'admin_list_schedule', s.id, null, 'bogus'), '22023', /unknown status/);
    const allocated = (await w.rpc(adm, 'admin_list_schedule', s.id, null, 'allocated', 50, 0)).rows;
    assert.ok(allocated.every((r) => /^R[123]$/.test(r.room_code)));
    // page size is capped server side
    assert.ok((await w.rpc(adm, 'admin_list_schedule', null, null, null, 100000, 0)).rows.length <= 500);
  });
});

test('allocation list and history: active/released filters, name search, room filter, correction chain', async () => {
  await withWorld(async (w) => {
    const { adm, s, r1, r2, r3, ids, a4 } = await scenario(w);
    const active = await w.rpc(adm, 'admin_list_allocations', s.id);
    assert.equal(active.total, 3);
    const released = await w.rpc(adm, 'admin_list_allocations', s.id, null, null, 'released');
    assert.equal(released.total, 1);
    assert.equal(released.rows[0].id, a4.id);
    assert.equal(released.rows[0].release_reason, 'left early');
    assert.equal((await w.rpc(adm, 'admin_list_allocations', s.id, null, null, 'all')).total, 4);
    assert.equal((await w.rpc(adm, 'admin_list_allocations', s.id, null, 'name e0002')).total, 1);
    const r2rows = await w.rpc(adm, 'admin_list_allocations', s.id, r2.id);
    assert.equal(r2rows.total, 1);
    assert.equal(r2rows.rows[0].room_code, 'R2');
    await rejects(w.rpc(adm, 'admin_list_allocations', s.id, null, null, 'weird'), '22023', /state/);

    // move E0001 to another room and look at the chain
    const cur = await w.one(`select id, session_room_id from allocations where employee_id = $1 and released_at is null`, [ids[0]]);
    const target = [r1, r3].find((r) => r.id !== cur.session_room_id);
    await w.rpc(adm, 'admin_reassign', cur.id, target.id, 'balance load');
    const hist = await w.rpc(adm, 'admin_allocation_history', s.id, ' e0001 ');
    assert.equal(hist.length, 2);
    assert.equal(hist[0].released_at !== null, true);
    assert.match(hist[0].release_reason, /^reassigned: balance load/);
    assert.equal(hist[1].source, 'admin_correction');
    assert.equal(hist[1].supersedes_allocation_id, hist[0].id);
    assert.ok(hist[1].created_by);
  });
});

test('flag and authorization lists expose status, reason, names and references', async () => {
  await withWorld(async (w) => {
    const { adm, s, ids, flag } = await scenario(w);
    await w.rpc(adm, 'admin_flag_employee', ids[5], s.id, 'duplicate claim');
    const open = await w.rpc(adm, 'admin_list_flags');
    assert.equal(open.total, 2);
    assert.deepEqual(open.rows.map((f) => f.employee_id).sort(), ['E0005', 'E0006']);
    const f5 = open.rows.find((f) => f.employee_id === 'E0005');
    assert.equal(f5.reason, 'ID photo mismatch');
    assert.equal(f5.employee_name, 'Name E0005');
    assert.equal(f5.reference, flag.reference);
    await w.rpc(adm, 'admin_resolve_flag', flag.flag_id, 'cleared', 'ID checked at desk');
    assert.equal((await w.rpc(adm, 'admin_list_flags')).total, 1);
    assert.equal((await w.rpc(adm, 'admin_list_flags', 'cleared')).rows[0].resolution_note, 'ID checked at desk');
    assert.equal((await w.rpc(adm, 'admin_list_flags', null)).total, 2);
    assert.equal((await w.rpc(adm, 'admin_list_flags', 'open', null, 'e0006')).total, 1);
    await rejects(w.rpc(adm, 'admin_list_flags', 'nope'), '22023', /unknown status/);

    await w.rpc(adm, 'admin_authorize_reentry', ids[3], s.id, 'back on duty');
    await w.rpc(adm, 'admin_authorize_late', ids[6], s.id, 'bus breakdown');
    const auth = await w.rpc(adm, 'admin_list_authorizations');
    assert.equal(auth.total, 2);
    assert.deepEqual(auth.rows.map((a) => [a.kind, a.status]).sort(), [['late', 'open'], ['reentry', 'open']]);
    assert.equal((await w.rpc(adm, 'admin_list_authorizations', null, 'late')).rows[0].reason, 'bus breakdown');
    const anon = await w.as('anon');
    await w.checkin(anon, ids[3]);                                          // consumes the re-entry permit
    assert.equal((await w.rpc(adm, 'admin_list_authorizations', null, null, 'consumed')).total, 1);
    assert.equal((await w.rpc(adm, 'admin_list_authorizations', null, null, 'open')).total, 1);
    await rejects(w.rpc(adm, 'admin_list_authorizations', null, 'x'), '22023', /kind/);
  });
});

test('audit viewer: filters by action, text (incl. JSON content), date range, pagination; read-only', async () => {
  await withWorld(async (w) => {
    const { adm, s, ids } = await scenario(w);
    const total = (await w.rpc(adm, 'admin_list_audit')).total;
    assert.equal(total, 6, '4 allocation.create + 1 release + 1 flag');
    const create = await w.rpc(adm, 'admin_list_audit', null, 'allocation.create');
    assert.equal(create.total, 4);
    assert.ok(create.rows.every((r) => r.actor.startsWith('employee:')));
    const rel = await w.rpc(adm, 'admin_list_audit', null, 'allocation.release');
    assert.equal(rel.total, 1);
    assert.equal(rel.rows[0].admin_name, 'admin@example.test', 'admin shown by display name');
    assert.equal(rel.rows[0].after.release_reason, 'left early');
    assert.ok(rel.rows[0].request_id);
    assert.ok(rel.actions.includes('allocation.release') && rel.actions.includes('flag.create'));
    assert.equal((await w.rpc(adm, 'admin_list_audit', 'E0005')).total >= 1, true, 'search by employee in entity/JSON');
    assert.equal((await w.rpc(adm, 'admin_list_audit', 'ID photo mismatch')).total, 1, 'search inside JSON');
    const page1 = await w.rpc(adm, 'admin_list_audit', null, null, null, null, 3, 0);
    const page2 = await w.rpc(adm, 'admin_list_audit', null, null, null, null, 3, 3);
    assert.equal(page1.rows.length, 3);
    assert.ok(page1.rows[2].id > page2.rows[0].id, 'newest first, no overlap');
    const future = await w.rpc(adm, 'admin_list_audit', null, null, new Date(Date.now() + 86400000).toISOString());
    assert.equal(future.total, 0);
    const window = await w.rpc(adm, 'admin_list_audit', null, null, new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString());
    assert.equal(window.total, total);
    assert.equal((await w.rpc(adm, 'admin_list_audit', '%')).total, 0, 'wildcard is literal');
    // read-only: viewing never writes
    await w.rpc(adm, 'admin_list_audit');
    assert.equal((await w.rpc(adm, 'admin_list_audit')).total, total);
    assert.ok(s && ids);
  });
});

test('reports: every report returns ordered columns, rows, a total; filters by session and date', async () => {
  await withWorld(async (w) => {
    const { adm, anon, s, ids } = await scenario(w);
    await w.rpc(adm, 'admin_authorize_late', ids[7], s.id, 'train delay');
    const rep = (name, ...a) => w.rpc(adm, 'admin_report', name, s.id, ...a);

    const sa = await rep('session_allocations');
    assert.equal(sa.total, 3);
    assert.deepEqual(sa.columns, ['exam_date', 'session', 'employee_id', 'employee_name', 'department', 'room_code', 'building', 'floor', 'round', 'source', 'allocated_at_ist']);
    assert.ok(sa.rows.every((r) => sa.columns.every((c) => c in r)));
    assert.match(sa.rows[0].allocated_at_ist, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const ra = await rep('room_allocations');
    assert.equal(ra.total, 3);
    assert.equal(ra.rows.reduce((n, r) => n + r.allocated, 0), 3);
    const full = await rep('full_rooms');
    assert.ok(full.total >= 1 && full.rows.every((r) => r.status === 'full' && r.available === 0));

    const emp = await rep('employee_allocations');
    assert.equal(emp.total, 10);
    const un = await rep('unallocated');
    assert.equal(un.total, 7);
    assert.deepEqual([...new Set(un.rows.map((r) => r.status))].sort(), ['flagged', 'pending', 'released']);

    const late = await rep('late_checkins');
    assert.equal(late.total, 1);
    assert.equal(late.rows[0].reason, 'train delay');
    assert.equal(late.rows[0].status, 'open');
    await w.checkin(anon, ids[7]);
    assert.equal((await rep('late_checkins')).rows[0].status, 'used');
    assert.ok((await rep('late_checkins')).rows[0].room_code);

    const ver = await rep('verification_exceptions');
    assert.equal(ver.total, 1);
    assert.equal(ver.rows[0].reason, 'ID photo mismatch');
    const cor = await rep('corrections');
    assert.equal(cor.total, 1);
    assert.equal(cor.rows[0].action, 'released');
    assert.equal(cor.rows[0].reason, 'left early');
    const imp = await w.rpc(adm, 'admin_report', 'imports');
    assert.equal(imp.total, 0);

    // pagination + date filters
    const p = await w.rpc(adm, 'admin_report', 'employee_allocations', s.id, null, null, 4, 8);
    assert.equal(p.rows.length, 2);
    assert.equal(p.total, 10);
    const none = await w.rpc(adm, 'admin_report', 'verification_exceptions', s.id, new Date(Date.now() + 86400000).toISOString(), null);
    assert.equal(none.total, 0);
    // another session is excluded
    const other = await w.session({ label: 'AN', date: '2026-11-03', opens: 100, closes: 160 });
    assert.equal((await w.rpc(adm, 'admin_report', 'session_allocations', other.id)).total, 0);
    await rejects(w.rpc(adm, 'admin_report', 'nope', s.id), '22023', /unknown report/);
  });
});

test('import list and import report reflect committed batches', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    await w.session({ date: '2026-11-03', label: 'FN', opens: 0, closes: 60 });
    const b = await w.rpc(adm, 'admin_import_begin', 'roster.xlsx', 10, 2);
    await w.rpc(adm, 'admin_import_add_rows', b.batch_id, JSON.stringify([
      { row: 1, employee_id: 'E1', name: 'A', department: 'D', date: '2026-11-03', session: 'FN' },
      { row: 2, employee_id: 'E2', name: 'B', department: 'D', date: '2026-11-03', session: 'FN' }]));
    await w.rpc(adm, 'admin_import_validate', b.batch_id);
    await w.rpc(adm, 'admin_import_commit', b.batch_id, true);
    const l = await w.rpc(adm, 'admin_list_imports');
    assert.equal(l.total, 1);
    assert.deepEqual([l.rows[0].filename, l.rows[0].status, l.rows[0].inserted_count, l.rows[0].valid_count], ['roster.xlsx', 'committed', 2, 2]);
    const rep = await w.rpc(adm, 'admin_report', 'imports');
    assert.equal(rep.rows[0].inserted, 2);
    assert.equal(rep.rows[0].uploaded_by, 'admin@example.test');
    assert.equal(l.rows[0].uploaded_by_name, 'admin@example.test');
  });
});

test('every new read RPC rejects the public, non-admins and deactivated admins, and none of them writes', async () => {
  await withWorld(async (w) => {
    const { adm, s } = await scenario(w);
    const U = crypto.randomUUID();
    const READS = [
      ['admin_overview', []], ['admin_room_monitor', [s.id]], ['admin_list_sessions', []], ['admin_list_rooms', []],
      ['admin_list_schedule', []], ['admin_list_allocations', []], ['admin_allocation_history', [s.id, 'E1']],
      ['admin_list_flags', []], ['admin_list_authorizations', []], ['admin_list_audit', []], ['admin_list_imports', []],
      ['admin_report', ['session_allocations']],
    ];
    const anon = await w.as('anon');
    const stranger = await w.as('authenticated', { sub: U });
    const goneId = await w.admin('gone@example.test');
    await w.q('update admins set is_active = false where user_id = $1', [goneId]);
    const gone = await w.as('authenticated', { sub: goneId });
    for (const [n, args] of READS) {
      await assert.rejects(w.rpc(anon, n, ...args), (e) => e.code === '42501', n + ' anon');
      for (const c of [stranger, gone]) {
        await assert.rejects(w.rpc(c, n, ...args), (e) => e.code === '42501' && /not authorized/.test(e.message), n + ' non-admin');
      }
    }
    const snap = async () => JSON.stringify(await w.q(`select
      (select count(*) from audit_log) a, (select count(*) from allocations) b, (select count(*) from schedule) c,
      (select count(*) from check_attempts) d, (select count(*) from import_rows) e`));
    const before = await snap();
    for (const [n, args] of READS) await w.rpc(adm, n, ...args);
    assert.equal(await snap(), before, 'read RPCs changed nothing');
    // they are STABLE (read-only by declaration)
    const vol = await w.q(`select proname from pg_proc where pronamespace = 'public'::regnamespace
                             and proname = any($1) and provolatile <> 's'`, [READS.map(([n]) => n)]);
    assert.deepEqual(vol, []);
  });
});

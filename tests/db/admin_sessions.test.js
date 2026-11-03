'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { World, buildTemplate, dropTemplate } = require('./harness');

before(buildTemplate);
after(dropTemplate);

async function withWorld(fn) {
  const w = await World.create();
  try { await fn(w); } finally { await w.close(); }
}

const rejects = (p, code, re) =>
  assert.rejects(p, (e) => (code ? e.code === code : true) && (re ? re.test(e.message) : true), `${code} ${re}`);

test('create session: Asia/Kolkata local time is converted correctly, validated and audited', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const r = await w.rpc(adm, 'admin_create_session', '2026-11-03', 'forenoon', '2026-11-03 08:00', '2026-11-03 10:30');
    assert.equal(r.ok, true);
    assert.equal(r.session.session, 'FN');
    assert.equal(r.session.checkin_opens_at_ist, '2026-11-03 08:00');
    assert.equal(r.session.checkin_closes_at_ist, '2026-11-03 10:30');
    const row = await w.one(`select to_char(checkin_opens_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') o,
                                    to_char(checkin_closes_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') c, is_active
                               from exam_sessions`);
    assert.equal(row.o, '2026-11-03 02:30', '08:00 IST = 02:30 UTC');
    assert.equal(row.c, '2026-11-03 05:00', '10:30 IST = 05:00 UTC');
    assert.equal(row.is_active, true);

    const a = await w.one(`select actor, actor_user_id, action, entity, before, after, request_id from audit_log`);
    assert.equal(a.action, 'session.create');
    assert.equal(a.actor, 'admin:' + adm.adminId);
    assert.equal(a.actor_user_id, adm.adminId);
    assert.equal(a.before, null);
    assert.equal(a.after.checkin_opens_at_ist, '2026-11-03 08:00');
    assert.ok(a.request_id);
  });
});

test('invalid windows and inputs are rejected', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const mk = (...a) => w.rpc(adm, 'admin_create_session', ...a);
    await rejects(mk('2026-11-03', 'FN', '2026-11-03 10:00', '2026-11-03 08:00'), '22023', /after opening/);
    await rejects(mk('2026-11-03', 'FN', '2026-11-03 10:00', '2026-11-03 10:00'), '22023', /after opening/);
    await rejects(mk('2026-11-03', 'FN', '2026-11-02 08:00', '2026-11-03 10:00'), '22023', /24 hours/);
    await rejects(mk('2026-11-03', 'FN', '2026-11-05 08:00', '2026-11-05 10:00'), '22023', /include the examination date/);
    await rejects(mk('2026-11-03', 'FN', '2026-11-03T08:00:00+05:30', '2026-11-03 10:00'), '22023', /no UTC offset/);
    await rejects(mk('2026-11-03', 'FN', '2026-11-03T08:00:00Z', '2026-11-03 10:00'), '22023', /no UTC offset/);
    await rejects(mk('2026-11-03', 'FN', '03-11-2026 08:00', '2026-11-03 10:00'), '22023', /Asia\/Kolkata/);
    await rejects(mk('2026-11-03', 'FN', '2026-13-45 08:00', '2026-11-03 10:00'), '22023', /valid date/);
    await rejects(mk('2026-11-03', 'EVENING', '2026-11-03 08:00', '2026-11-03 10:00'), '22023', /FN or AN/);
    await rejects(mk(null, 'FN', '2026-11-03 08:00', '2026-11-03 10:00'), '22023', /exam date/);
    assert.equal((await w.one('select count(*)::int c from exam_sessions')).c, 0);
    assert.equal((await w.one('select count(*)::int c from audit_log')).c, 0, 'rejections write nothing');
  });
});

test('overlapping active windows are rejected with a clear message; adjacent, inactive and duplicates handled', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const mk = (...a) => w.rpc(adm, 'admin_create_session', ...a);
    await mk('2026-11-03', 'FN', '2026-11-03 08:00', '2026-11-03 10:00');
    await rejects(mk('2026-11-03', 'AN', '2026-11-03 09:00', '2026-11-03 12:00'), '23P01', /overlaps another active session/);
    await mk('2026-11-03', 'AN', '2026-11-03 10:00', '2026-11-03 12:00');                    // adjacent
    await mk('2026-11-04', 'FN', '2026-11-04 08:00', '2026-11-04 10:00', false);
    await mk('2026-11-04', 'AN', '2026-11-04 08:30', '2026-11-04 10:00', false);              // overlapping but both inactive
    await rejects(mk('2026-11-03', 'FN', '2026-11-03 14:00', '2026-11-03 15:00'), '23505', /already exists/);
    assert.equal((await w.one('select count(*)::int c from exam_sessions')).c, 4);
  });
});

test('update session: windows change, NULL means unchanged, overlap rejected, before/after audited', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const s1 = (await w.rpc(adm, 'admin_create_session', '2026-11-03', 'FN', '2026-11-03 08:00', '2026-11-03 10:00')).session;
    const s2 = (await w.rpc(adm, 'admin_create_session', '2026-11-03', 'AN', '2026-11-03 13:00', '2026-11-03 15:00')).session;

    const u = await w.rpc(adm, 'admin_update_session', s1.id, null, null, null, '2026-11-03 10:30');
    assert.equal(u.session.checkin_opens_at_ist, '2026-11-03 08:00', 'opening unchanged');
    assert.equal(u.session.checkin_closes_at_ist, '2026-11-03 10:30');
    await rejects(w.rpc(adm, 'admin_update_session', s1.id, null, null, null, '2026-11-03 14:00'), '23P01', /overlaps/);
    await rejects(w.rpc(adm, 'admin_update_session', s1.id, null, null, '2026-11-03 11:00', null), '22023', /after opening/);
    await rejects(w.rpc(adm, 'admin_update_session', s1.id, null, 'EVENING'), '22023', /FN or AN/);
    await rejects(w.rpc(adm, 'admin_update_session', '00000000-0000-0000-0000-000000000000', null), '22023', /not found/);

    const a = await w.one(`select before, after from audit_log where action = 'session.update' order by id desc limit 1`);
    assert.equal(a.before.checkin_closes_at_ist, '2026-11-03 10:00');
    assert.equal(a.after.checkin_closes_at_ist, '2026-11-03 10:30');
    assert.equal(s2.is_active, true);
  });
});

test('date/session are frozen once the schedule or allocations reference the session; windows can still change', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const anon = await w.as('anon');

    // free to change while nothing references the session
    const free = (await w.rpc(adm, 'admin_create_session', '2026-11-03', 'FN', '2026-11-03 08:00', '2026-11-03 10:00')).session;
    const moved = await w.rpc(adm, 'admin_update_session', free.id, '2026-11-05', null, '2026-11-05 08:00', '2026-11-05 10:00');
    assert.equal(moved.session.exam_date, '2026-11-05');
    assert.equal((await w.rpc(adm, 'admin_update_session', free.id, null, 'AN')).session.session, 'AN');

    // a session that is open "now" (IST today) with a schedule row and then an allocation
    const today = await w.istToday();
    const tomorrow = await w.istDate(1);
    const fn = await w.session({ date: today, label: 'FN', opens: -30, closes: 30 });
    await w.rooms(fn, [2]);
    await w.schedule('E1', fn);
    const toTomorrow = [fn.id, tomorrow, null, `${tomorrow} 08:00`, `${tomorrow} 10:00`];
    await rejects(w.rpc(adm, 'admin_update_session', ...toTomorrow), '23514', /schedule already references/);
    await rejects(w.rpc(adm, 'admin_update_session', fn.id, null, 'AN'), '23514', /schedule already references/);

    assert.equal((await w.checkin(anon, 'E1')).code, 'ALLOCATED');
    await rejects(w.rpc(adm, 'admin_update_session', ...toTomorrow), '23514', /(already has allocations|schedule already references)/);
    // window changes are still allowed while allocations exist (and are audited)
    const ok = await w.rpc(adm, 'admin_update_session', fn.id, null, null, null, await w.ist(90));
    assert.equal(ok.ok, true);
    // the database itself refuses a direct edit of identity columns once allocations exist
    await w.q('delete from schedule');
    await rejects(w.q(`update exam_sessions set exam_date = '2030-01-01' where id = $1`, [fn.id]), '23514', /allocations/);
  });
});

test('deactivate an active session: confirmation needed when allocations exist; check-in then closes; reactivation checks overlap', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const anon = await w.as('anon');
    const s = await w.session({ label: 'FN', opens: -30, closes: 30 });
    await w.rooms(s, [2]);
    await w.schedule('E1', s);
    await w.schedule('E2', s);
    assert.equal((await w.checkin(anon, 'E1')).code, 'ALLOCATED');

    await rejects(w.rpc(adm, 'admin_set_session_active', s.id, false, 'event cancelled'), '22023', /1 active allocations.*p_confirm/);
    await rejects(w.rpc(adm, 'admin_set_session_active', s.id, false, 'no'), '22023', /reason/);
    const off = await w.rpc(adm, 'admin_set_session_active', s.id, false, 'Exam postponed', true);
    assert.equal(off.session.is_active, false);
    assert.equal(off.active_allocations, 1);
    assert.equal((await w.checkin(anon, 'E2')).code, 'NO_ACTIVE_SESSION');
    assert.equal((await w.one(`select count(*)::int c from allocations where released_at is null`)).c, 1, 'existing allocation untouched');

    // another session takes over the window, so re-activation must be refused
    await w.q(`insert into exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at)
               values ('2026-11-03', 'AN', now() - interval '10 minutes', now() + interval '20 minutes')`);
    await rejects(w.rpc(adm, 'admin_set_session_active', s.id, true, 'oops'), '23P01', /overlaps/);

    const a = await w.one(`select before, after, actor from audit_log where action = 'session.deactivate'`);
    assert.equal(a.before.is_active, true);
    assert.equal(a.after.is_active, false);
    assert.equal(a.after.reason, 'Exam postponed');
    assert.equal(a.actor, 'admin:' + adm.adminId);

    const same = await w.rpc(adm, 'admin_set_session_active', s.id, false, 'again nothing', true);
    assert.equal(same.unchanged, true);
  });
});

test('deactivating a session with no active allocations needs no confirmation', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const s = await w.session({ label: 'FN', opens: -30, closes: 30 });
    const r = await w.rpc(adm, 'admin_set_session_active', s.id, false, 'not needed any more');
    assert.equal(r.session.is_active, false);
    const back = await w.rpc(adm, 'admin_set_session_active', s.id, true, 'needed again');
    assert.equal(back.session.is_active, true);
  });
});

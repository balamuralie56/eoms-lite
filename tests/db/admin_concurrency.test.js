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

const row = (n, id, name = 'N', dept = 'D') => ({ row: n, employee_id: id, name, department: dept, date: '2026-11-03', session: 'FN' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Holds the session's advisory lock (same key as eoms_private.lock_session) in an open transaction. */
async function holdSessionLock(w, sessionId) {
  const holder = await w.as('anon');
  await holder.query('reset role');
  await holder.query('begin');
  await holder.query(`select pg_advisory_xact_lock(hashtextextended('eoms:session:' || $1::text, 0))`, [sessionId]);
  return { release: () => holder.query('rollback') };
}

/** Starts fn(), proves it is blocked while the lock is held, then proves it completes after release. */
async function assertWaitsForSessionLock(w, sessionId, label, fn) {
  const lock = await holdSessionLock(w, sessionId);
  let settled = false;
  const p = fn().then((r) => { settled = true; return r; }, (e) => { settled = true; throw e; });
  await sleep(700);
  assert.equal(settled, false, `${label} must wait for the session lock (it shares the allocation lock)`);
  await lock.release();
  return p;
}

test('session configuration shares the allocation lock: updates, (de)activation wait for in-flight allocation', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    // today's IST date, not the harness's fixed one: admin_update_session requires the window to include the exam date
    const s = await w.session({ date: await w.istToday(), opens: -30, closes: 30 });
    await w.rooms(s, [3]);
    const closes = await w.ist(90);
    const u = await assertWaitsForSessionLock(w, s.id, 'admin_update_session', () => w.rpc(adm, 'admin_update_session', s.id, null, null, null, closes));
    assert.equal(u.ok, true);
    const d = await assertWaitsForSessionLock(w, s.id, 'admin_set_session_active', () => w.rpc(adm, 'admin_set_session_active', s.id, false, 'testing lock'));
    assert.equal(d.session.is_active, false);
  });
});

test('room configuration shares the allocation lock: capacity, room activation, session-room changes wait', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const s = await w.session({ opens: -30, closes: 30 });
    const [sr] = await w.rooms(s, [3]);
    const roomId = sr.room_id;
    const a = await assertWaitsForSessionLock(w, s.id, 'admin_update_session_room', () => w.rpc(adm, 'admin_update_session_room', sr.id, 4));
    assert.equal(a.session_room.max_invigilators, 4);
    const b = await assertWaitsForSessionLock(w, s.id, 'admin_set_session_room_active', () => w.rpc(adm, 'admin_set_session_room_active', sr.id, false, 'testing lock'));
    assert.equal(b.session_room.is_active, false);
    const c = await assertWaitsForSessionLock(w, s.id, 'admin_set_room_active', () => w.rpc(adm, 'admin_set_room_active', roomId, false, 'testing lock'));
    assert.equal(c.room.is_active, false);
    const d = await assertWaitsForSessionLock(w, s.id, 'admin_update_room', () => w.rpc(adm, 'admin_update_room', roomId, 'RENAMED'));
    assert.equal(d.room.room_code, 'RENAMED');
    const extra = (await w.rpc(adm, 'admin_create_room', 'EXTRA')).room;
    const e = await assertWaitsForSessionLock(w, s.id, 'admin_assign_room_to_session', () => w.rpc(adm, 'admin_assign_room_to_session', s.id, extra.id, 2));
    assert.equal(e.ok, true);
  });
});

test('capacity changes racing with check-ins can never cause over-allocation', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const s = await w.session({ opens: -30, closes: 30 });
    const [sr] = await w.rooms(s, [20]);
    const ids = await w.scheduleMany('E', 60, s);
    const pool = w.anonPool(40);
    await Promise.all(Array.from({ length: 40 }, () => pool.query('select 1')));

    const caps = [20, 12, 20, 8, 20, 15, 20, 5, 20, 10, 20];       // admin keeps changing the capacity meanwhile
    const adminOps = (async () => {
      const out = [];
      for (const c of caps) {
        try { out.push(await w.rpc(adm, 'admin_update_session_room', sr.id, c)); }
        catch (e) { out.push({ err: e.code, msg: e.message }); }
      }
      return out;
    })();
    const checkins = Promise.all(ids.map((id) => pool.query('select public.checkin($1) as r', [id]).then((x) => x.rows[0].r)));
    const [ops, res] = await Promise.all([adminOps, checkins]);

    for (const o of ops.filter((x) => x.err)) assert.equal(o.err, '23514', 'only clean capacity rejections: ' + o.msg);
    for (const r of res) assert.ok(['ALLOCATED', 'ROOMS_FULL'].includes(r.code), JSON.stringify(r));
    const final = await w.one(`select sr.max_invigilators m, count(a.id) filter (where a.released_at is null)::int n
                                 from session_rooms sr left join allocations a on a.session_room_id = sr.id where sr.id = $1 group by 1`, [sr.id]);
    assert.ok(final.n <= final.m, `active ${final.n} must not exceed capacity ${final.m}`);
    assert.equal(res.filter((r) => r.code === 'ALLOCATED').length, final.n);
    assert.deepEqual(await integrityProblems(w), []);
    // every successful capacity change was valid at the instant it committed (audit shows before/after)
    const audits = await w.q(`select after from audit_log where action = 'session_room.update_capacity'`);
    for (const a of audits) assert.ok(a.after.max_invigilators >= 1);
  });
});

test('room/session (de)activation racing with check-ins keeps every invariant', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const s = await w.session({ opens: -30, closes: 30 });
    const srs = await w.rooms(s, [10, 10, 10, 10]);
    const ids = await w.scheduleMany('E', 50, s);
    const pool = w.anonPool(40);
    await Promise.all(Array.from({ length: 40 }, () => pool.query('select 1')));

    const adminOps = (async () => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        const target = srs[i % srs.length];
        for (const active of [false, true]) {
          try { out.push(await w.rpc(adm, 'admin_set_session_room_active', target.id, active, 'race test', true)); }
          catch (e) { out.push({ err: e.code }); }
        }
      }
      return out;
    })();
    const checkins = Promise.all(ids.map((id) => pool.query('select public.checkin($1) as r', [id]).then((x) => x.rows[0].r)));
    const [ops, res] = await Promise.all([adminOps, checkins]);
    assert.equal(ops.filter((o) => o.err).length, 0);
    for (const r of res) assert.ok(['ALLOCATED', 'ROOMS_FULL'].includes(r.code), JSON.stringify(r));
    // every room is active again at the end; nothing is over capacity or duplicated
    assert.deepEqual(await integrityProblems(w), []);
    assert.equal((await w.one(`select count(*)::int c from allocations where released_at is null`)).c,
                 res.filter((r) => r.code === 'ALLOCATED').length);
  });
});

test('two simultaneous imports of the same rows create no duplicates: exactly one commits', async () => {
  await withWorld(async (w) => {
    await w.session({ date: '2026-11-03', label: 'FN', opens: 0, closes: 60 });
    const rows = Array.from({ length: 150 }, (_, i) => row(i + 1, 'E' + String(i + 1).padStart(4, '0')));
    const admins = await Promise.all(Array.from({ length: 4 }, (_, i) => w.adminClient(`a${i}@example.test`)));

    // each admin stages and validates their own copy first (all see 150 valid rows)
    const batches = [];
    for (const adm of admins) {
      const b = await w.rpc(adm, 'admin_import_begin', 'same.csv', 1000, rows.length);
      await w.rpc(adm, 'admin_import_add_rows', b.batch_id, JSON.stringify(rows));
      const v = await w.rpc(adm, 'admin_import_validate', b.batch_id);
      assert.equal(v.summary.valid, 150);
      batches.push({ adm, id: b.batch_id });
    }
    const results = await Promise.all(batches.map(({ adm, id }) => w.rpc(adm, 'admin_import_commit', id, true, 'skip')));

    assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.code || 'OK')));
    for (const r of results.filter((x) => !x.ok)) assert.equal(r.code, 'CHANGED_SINCE_PREVIEW');
    assert.equal((await w.one('select count(*)::int c from schedule')).c, 150);
    const dup = await w.q(`select employee_id, exam_date, session_label, count(*) from schedule group by 1,2,3 having count(*) > 1`);
    assert.deepEqual(dup, []);
    assert.equal((await w.q(`select 1 from import_batches where status = 'committed'`)).length, 1);
    assert.equal((await w.q(`select 1 from audit_log where action = 'import.commit'`)).length, 1);
  });
});

test('simultaneous imports with overlapping rows: no duplicates, no lost rows, no partial batch', async () => {
  await withWorld(async (w) => {
    await w.session({ date: '2026-11-03', label: 'FN', opens: 0, closes: 60 });
    const a = Array.from({ length: 100 }, (_, i) => row(i + 1, 'E' + String(i + 1).padStart(4, '0')));          // 1..100
    const b = Array.from({ length: 100 }, (_, i) => row(i + 1, 'E' + String(i + 51).padStart(4, '0')));         // 51..150
    const [adm1, adm2] = await Promise.all([w.adminClient('x@example.test'), w.adminClient('y@example.test')]);
    const stageOne = async (adm, rows) => {
      const bt = await w.rpc(adm, 'admin_import_begin', 'f.csv', 1000, rows.length);
      await w.rpc(adm, 'admin_import_add_rows', bt.batch_id, JSON.stringify(rows));
      await w.rpc(adm, 'admin_import_validate', bt.batch_id);
      return bt.batch_id;
    };
    const [ba, bb] = [await stageOne(adm1, a), await stageOne(adm2, b)];
    const [ra, rb] = await Promise.all([w.rpc(adm1, 'admin_import_commit', ba, true, 'skip'), w.rpc(adm2, 'admin_import_commit', bb, true, 'skip')]);

    // whichever ran second saw the other's rows as exact duplicates: its counts changed, so it must be re-run
    const okCount = [ra, rb].filter((r) => r.ok).length;
    assert.equal(okCount, 1);
    const loser = ra.ok ? rb : ra;
    assert.equal(loser.code, 'CHANGED_SINCE_PREVIEW');
    const loserId = ra.ok ? bb : ba;
    const retry = await w.rpc(ra.ok ? adm2 : adm1, 'admin_import_commit', loserId, true, 'skip');
    assert.equal(retry.ok, true);
    assert.equal((await w.one('select count(*)::int c from schedule')).c, 150, 'union of both files, each employee once');
    const dup = await w.q(`select employee_id from schedule group by employee_id having count(*) > 1`);
    assert.deepEqual(dup, []);
  });
});

test('import commit waits for another import commit (global import lock)', async () => {
  await withWorld(async (w) => {
    await w.session({ date: '2026-11-03', label: 'FN', opens: 0, closes: 60 });
    const adm = await w.adminClient();
    const b = await w.rpc(adm, 'admin_import_begin', 'f.csv', 100, 1);
    await w.rpc(adm, 'admin_import_add_rows', b.batch_id, JSON.stringify([row(1, 'E1')]));
    await w.rpc(adm, 'admin_import_validate', b.batch_id);

    const holder = await w.as('anon');
    await holder.query('reset role');
    await holder.query('begin');
    await holder.query(`select pg_advisory_xact_lock(hashtextextended('eoms:schedule-import', 0))`);
    let settled = false;
    const p = w.rpc(adm, 'admin_import_commit', b.batch_id, true).then((r) => { settled = true; return r; });
    await sleep(700);
    assert.equal(settled, false, 'commit must wait for the import lock');
    await holder.query('rollback');
    assert.equal((await p).ok, true);
  });
});

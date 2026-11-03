'use strict';
// Concurrency tests against real PostgreSQL. Latency numbers printed here come from a local
// Docker database on this machine: they are NOT a statement about Supabase free-tier performance.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { World, buildTemplate, dropTemplate, replayViolations, integrityProblems } = require('./harness');

before(buildTemplate);
after(dropTemplate);

async function withWorld(fn) {
  const w = await World.create();
  try { await fn(w); } finally { await w.close(); }
}

/** Fire all submissions at once through a pool of `conns` connections. Returns [{r, ms}]. */
async function burst(w, ids, conns) {
  const pool = w.anonPool(conns);
  // warm the pool so connection setup is not measured as allocation latency
  await Promise.all(Array.from({ length: conns }, () => pool.query('select 1')));
  return Promise.all(ids.map(async (id) => {
    const t0 = process.hrtime.bigint();
    const res = await pool.query('select public.checkin($1) as r', [id]);
    return { r: res.rows[0].r, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  }));
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const tally = (res) => res.reduce((m, { r }) => ((m[r.code] = (m[r.code] || 0) + 1), m), {});

test('concurrent duplicate submissions of ONE employee create exactly one active allocation', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [3, 3, 3, 3, 3, 3]);
    await w.schedule('DUP1', s);
    const res = await burst(w, Array(60).fill('dup1'), 60);
    const t = tally(res);
    assert.equal(t.ALLOCATED, 1, JSON.stringify(t));
    assert.equal(t.ALREADY_ALLOCATED, 59, JSON.stringify(t));
    assert.equal(new Set(res.map(({ r }) => r.room_code)).size, 1, 'every caller sees the same room');
    assert.equal(new Set(res.map(({ r }) => r.reference)).size, 1);
    assert.equal((await w.one(`select count(*)::int c from allocations where released_at is null`)).c, 1);
    assert.deepEqual(await integrityProblems(w), []);
  });
});

test('many duplicates across many employees at once: one active allocation each', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, Array(10).fill(10));
    const ids = await w.scheduleMany('E', 40, s);
    const flood = ids.flatMap((id) => [id, id, id.toLowerCase(), ` ${id} `]);   // 160 requests, 4 per employee
    const res = await burst(w, flood, 80);
    const t = tally(res);
    assert.equal(t.ALLOCATED, 40, JSON.stringify(t));
    assert.equal(t.ALREADY_ALLOCATED, 120, JSON.stringify(t));
    assert.equal((await w.one(`select count(*)::int c from allocations where released_at is null`)).c, 40);
    assert.deepEqual(await integrityProblems(w), []);
    assert.deepEqual(await replayViolations(w, s), []);
  });
});

test('concurrent DIFFERENT employees never exceed capacity; policy order is preserved (60 concurrent, 10 slots)', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [1, 2, 3, 2, 2]);                 // 10 slots
    const ids = await w.scheduleMany('E', 60, s);
    const res = await burst(w, ids, 60);
    const t = tally(res);
    assert.equal(t.ALLOCATED, 10, JSON.stringify(t));
    assert.equal(t.ROOMS_FULL, 50, JSON.stringify(t));
    assert.equal(t.BUSY || 0, 0, 'no lock timeouts at this scale');
    assert.deepEqual(await w.counts(s), { R1: 1, R2: 2, R3: 3, R4: 2, R5: 2 });
    assert.deepEqual(await integrityProblems(w), []);
    assert.deepEqual(await replayViolations(w, s), [], 'every allocation went to a minimum-count eligible room');
  });
});

test('200 concurrent requests (150 slots): capacity exact, policy order preserved, latency reported', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const caps = [];
    for (let i = 0; i < 30; i++) caps.push(1 + (i % 9));   // 30 rooms, capacities 1..9
    const slots = caps.reduce((a, b) => a + b, 0);
    await w.rooms(s, caps);
    const ids = await w.scheduleMany('E', 200, s);
    const t0 = Date.now();
    const res = await burst(w, ids, 100);
    const wall = Date.now() - t0;
    const t = tally(res);
    const lat = res.map((x) => x.ms);
    console.log(`# 200-concurrent (local docker, 100 connections): wall=${wall}ms p50=${pct(lat, 50).toFixed(0)}ms ` +
                `p95=${pct(lat, 95).toFixed(0)}ms p99=${pct(lat, 99).toFixed(0)}ms max=${Math.max(...lat).toFixed(0)}ms codes=${JSON.stringify(t)} slots=${slots}`);
    assert.equal(t.ALLOCATED, slots, JSON.stringify(t));
    assert.equal(t.ROOMS_FULL, 200 - slots, JSON.stringify(t));
    assert.equal(t.BUSY || 0, 0, 'no lock timeouts');
    assert.deepEqual(await integrityProblems(w), []);
    assert.deepEqual(await replayViolations(w, s), []);
  });
});

test('allocation running concurrently with admin corrections and releases keeps every invariant', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const rooms = await w.rooms(s, [4, 4, 4, 4, 4, 4]);   // 24 slots
    const ids = await w.scheduleMany('E', 40, s);
    const anon = await w.as('anon');
    for (const id of ids.slice(0, 12)) assert.equal((await w.checkin(anon, id)).code, 'ALLOCATED');

    const adminId = await w.admin();
    const admins = await Promise.all(Array.from({ length: 4 }, () => w.as('authenticated', { sub: adminId })));
    const existing = (await w.q(`select id from allocations where released_at is null order by seq`)).map((r) => r.id);

    const pool = w.anonPool(30);
    const tasks = [];
    for (const id of ids.slice(12)) tasks.push(pool.query('select public.checkin($1) as r', [id]).then((x) => ({ kind: 'checkin', r: x.rows[0].r })));
    existing.forEach((allocId, i) => {
      const adm = admins[i % admins.length];
      if (i % 3 === 0) {
        tasks.push(adm.query('select public.admin_release($1,$2) as r', [allocId, 'concurrent release test'])
          .then((x) => ({ kind: 'release', r: x.rows[0].r })).catch((e) => ({ kind: 'release', err: e })));
      } else {
        const target = rooms[(i * 5) % rooms.length].id;
        tasks.push(adm.query('select public.admin_reassign($1,$2,$3) as r', [allocId, target, 'concurrent move test'])
          .then((x) => ({ kind: 'reassign', r: x.rows[0].r })).catch((e) => ({ kind: 'reassign', err: e })));
      }
    });
    const out = await Promise.all(tasks);

    // Rejections by an admin RPC are fine ONLY if they are clean business rejections.
    for (const o of out.filter((x) => x.err)) {
      assert.ok(['22023', '23514'].includes(o.err.code), `unexpected admin error ${o.err.code}: ${o.err.message}`);
    }
    for (const o of out.filter((x) => x.kind === 'checkin')) {
      assert.ok(['ALLOCATED', 'ROOMS_FULL', 'ALREADY_ALLOCATED'].includes(o.r.code), JSON.stringify(o.r));
    }
    assert.deepEqual(await integrityProblems(w), []);

    // audit trail matches reality: every successful privileged call has exactly one audit row
    const okRelease = out.filter((x) => x.kind === 'release' && x.r).length;
    const okMove = out.filter((x) => x.kind === 'reassign' && x.r).length;
    const audit = await w.q(`select action, count(*)::int c from audit_log group by action`);
    const by = Object.fromEntries(audit.map((a) => [a.action, a.c]));
    assert.equal(by['allocation.release'] || 0, okRelease);
    assert.equal(by['allocation.reassign'] || 0, okMove);
    const created = out.filter((x) => x.kind === 'checkin' && x.r.code === 'ALLOCATED').length;
    assert.equal(by['allocation.create'], 12 + created);

    // every employee has at most one active allocation, and every released row has a reason
    const bad = await w.q(`select 1 from allocations where released_at is not null and (release_reason is null or btrim(release_reason) = '')`);
    assert.equal(bad.length, 0);
  });
});

test('a held session lock makes callers wait, and a timed-out waiter gets a retryable BUSY (no hang, no partial write)', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('E1', s);
    // Hold the session lock in an open transaction (simulates a stuck/slow concurrent writer).
    const holder = await w.as('anon');
    // The advisory lock key is derived exactly as in eoms_private.lock_session
    await holder.query('reset role');
    await holder.query('begin');
    await holder.query(`select pg_advisory_xact_lock(hashtextextended('eoms:session:' || $1::text, 0))`, [s.id]);

    const anon = await w.as('anon');
    const t0 = Date.now();
    const r = await w.checkin(anon, 'E1');
    const waited = Date.now() - t0;
    assert.equal(r.code, 'BUSY');
    assert.ok(waited >= 1900 && waited < 6000, `waited ${waited}ms (lock_timeout is 2s)`);
    await holder.query('rollback');

    assert.equal((await w.one('select count(*)::int c from allocations')).c, 0, 'no partial write');
    assert.equal((await w.checkin(anon, 'E1')).code, 'ALLOCATED', 'retry succeeds once the lock is free');
  });
});

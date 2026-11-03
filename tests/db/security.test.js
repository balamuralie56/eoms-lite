'use strict';
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

const ADMIN_FUNCS = [
  ['admin_authorize_late', ['x', crypto.randomUUID(), 'reason here']],
  ['admin_authorize_reentry', ['x', crypto.randomUUID(), 'reason here']],
  ['admin_revoke_authorization', [crypto.randomUUID(), 'reason here']],
  ['admin_release', [crypto.randomUUID(), 'reason here']],
  ['admin_reassign', [crypto.randomUUID(), crypto.randomUUID(), 'reason here']],
  ['admin_flag_employee', ['x', crypto.randomUUID(), 'reason here']],
  ['admin_resolve_flag', [crypto.randomUUID(), 'cleared', 'reason here']],
];
const call = (client, name, args) =>
  client.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args);

test('anonymous users cannot read any table directly (schedule, allocations, audit, admins, config)', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('E1', s);
    const anon = await w.as('anon');
    for (const t of ['schedule', 'allocations', 'audit_log', 'admins', 'exam_sessions', 'rooms', 'session_rooms',
                     'import_batches', 'admin_authorizations', 'employee_flags', 'check_attempts', 'app_settings']) {
      await assert.rejects(anon.query(`select * from public.${t}`), (e) => e.code === '42501', t);
    }
  });
});

test('anonymous users cannot write tables or call internal functions', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const [sr] = await w.rooms(s, [2]);
    const anon = await w.as('anon');
    await assert.rejects(anon.query(`insert into public.allocations (session_id, session_room_id, employee_id, round, source)
                                      values ($1, $2, 'E1', 1, 'normal')`, [s.id, sr.id]), (e) => e.code === '42501');
    await assert.rejects(anon.query(`insert into public.audit_log (actor, action) values ('x', 'y')`), (e) => e.code === '42501');
    await assert.rejects(anon.query(`insert into public.admins (user_id, email, display_name) values ($1, 'a', 'a')`, [crypto.randomUUID()]),
      (e) => e.code === '42501');
    await assert.rejects(anon.query(`select eoms_private.allocate($1, 'E1', 'normal')`, [s.id]), (e) => e.code === '42501');
    await assert.rejects(anon.query(`select eoms_private.lock_session($1)`, [s.id]), (e) => e.code === '42501');
  });
});

test('anonymous users cannot execute any admin function', async () => {
  await withWorld(async (w) => {
    const anon = await w.as('anon');
    for (const [name, args] of ADMIN_FUNCS) {
      await assert.rejects(call(anon, name, args), (e) => e.code === '42501', name);
    }
    await assert.rejects(anon.query('select public.is_admin()'), (e) => e.code === '42501');
  });
});

test('signed-in NON-admins and deactivated admins cannot run admin functions or read data', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('E1', s);
    const stranger = await w.as('authenticated', { sub: crypto.randomUUID() });
    const inactiveId = await w.admin('gone@example.test');
    await w.q('update admins set is_active = false where user_id = $1', [inactiveId]);
    const gone = await w.as('authenticated', { sub: inactiveId });
    const noSub = await w.as('authenticated');

    for (const c of [stranger, gone, noSub]) {
      for (const [name, args] of ADMIN_FUNCS) {
        await assert.rejects(call(c, name, args), (e) => e.code === '42501' && /not authorized/.test(e.message), name);
      }
      assert.equal((await c.query('select count(*)::int c from public.schedule')).rows[0].c, 0, 'RLS hides schedule');
      assert.equal((await c.query('select count(*)::int c from public.allocations')).rows[0].c, 0);
      assert.equal((await c.query('select public.is_admin() a')).rows[0].a, false);
    }
  });
});

// NOTE: admin functions take no admin-id argument; identity is auth.uid() from the verified JWT.
// In PostgREST the request GUCs are set by the server per request and a client cannot set them; this
// test only shows an anon connection holding an admin-looking claim still lacks EXECUTE.
test('anon cannot run admin functions even when an admin-looking claim is present', async () => {
  await withWorld(async (w) => {
    const realAdmin = await w.admin();
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.schedule('E1', s);
    const anon = await w.as('anon');
    // anon tries to smuggle an admin's uuid via every channel it controls: still denied
    await anon.query(`select set_config('request.jwt.claim.sub', $1, false)`, [realAdmin]);
    await assert.rejects(call(anon, 'admin_flag_employee', ['E1', s.id, 'reason here']), (e) => e.code === '42501');
  });
});

test('active admins can run admin functions and read everything via RLS; they still cannot write tables directly', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    const [sr] = await w.rooms(s, [2]);
    await w.schedule('E1', s);
    const adm = await w.as('authenticated', { sub: await w.admin() });
    assert.equal((await adm.query('select public.is_admin() a')).rows[0].a, true);
    assert.equal((await adm.query('select count(*)::int c from public.schedule')).rows[0].c, 1);
    const r = await call(adm, 'admin_flag_employee', ['E1', s.id, 'reason here']);
    assert.equal(r.rows[0].admin_flag_employee.ok, true);
    await assert.rejects(adm.query(`insert into public.allocations (session_id, session_room_id, employee_id, round, source)
                                     values ($1, $2, 'E1', 1, 'normal')`, [s.id, sr.id]), (e) => e.code === '42501');
    await assert.rejects(adm.query(`update public.schedule set employee_name = 'x'`), (e) => e.code === '42501');
    await assert.rejects(adm.query(`update public.audit_log set action = 'x'`), (e) => e.code === '42501');
    await assert.rejects(adm.query(`delete from public.audit_log`), (e) => e.code === '42501');
  });
});

test('public responses expose only the minimum: no other employee data, no schedule dump', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [3]);
    await w.schedule('E1', s, 'Alice Example', 'Physics');
    await w.schedule('E2', s, 'Bob Example', 'Maths');
    const anon = await w.as('anon');

    const ok = await w.checkin(anon, 'E1');
    assert.deepEqual(Object.keys(ok).sort(), [
      'allocated_at', 'building', 'code', 'department', 'employee_id', 'employee_name', 'exam_date',
      'floor', 'ok', 'reference', 'room_code', 'round', 'session']);
    assert.ok(!JSON.stringify(ok).includes('Bob'));

    const miss = await w.checkin(anon, 'E999');
    assert.deepEqual(Object.keys(miss).sort(), ['code', 'message', 'ok']);

    const st = (await anon.query('select public.get_checkin_status() s')).rows[0].s;
    assert.deepEqual(Object.keys(st).sort(), ['checkin_closes_at', 'exam_date', 'server_time', 'session', 'state']);
    await w.q('update exam_sessions set is_active = false');
    const closed = (await anon.query('select public.get_checkin_status() s')).rows[0].s;
    assert.deepEqual(Object.keys(closed).sort(), ['server_time', 'state']);
  });
});

test('catalog: SECURITY DEFINER functions pin search_path; no function is executable by PUBLIC; anon has only the two public RPCs', async () => {
  await withWorld(async (w) => {
    const fns = await w.q(`
      select n.nspname, p.proname, p.prosecdef, p.proconfig, p.proacl is null as default_acl,
             has_function_privilege('anon', p.oid, 'execute') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'eoms_private') and p.prokind = 'f'`);
    assert.ok(fns.length > 20, 'found our functions');
    for (const f of fns) {
      const cfg = (f.proconfig || []).join(',');
      assert.ok(cfg.includes('search_path=""'), `${f.nspname}.${f.proname} must set search_path=''`);
      assert.equal(f.default_acl, false, `${f.proname}: EXECUTE must not be left to PUBLIC`);
      if (f.nspname === 'eoms_private') {
        assert.equal(f.anon_exec || f.auth_exec, false, `${f.proname} must not be callable by API roles`);
      }
    }
    const anonCan = fns.filter((f) => f.anon_exec).map((f) => f.proname).sort();
    assert.deepEqual(anonCan, ['checkin', 'get_checkin_status']);
    for (const f of fns.filter((x) => x.nspname === 'public' && x.proname.startsWith('admin_'))) {
      assert.equal(f.auth_exec, true);
      assert.equal(f.anon_exec, false);
    }
    // the public RPCs run as definer so they can read tables the caller cannot
    for (const n of ['checkin', 'get_checkin_status']) {
      assert.equal(fns.find((f) => f.proname === n).prosecdef, true);
    }
  });
});

test('every table has RLS enabled and anon holds no table privileges', async () => {
  await withWorld(async (w) => {
    const tables = await w.q(`select c.relname, c.relrowsecurity,
        has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon_any
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`);
    assert.ok(tables.length >= 12);
    for (const t of tables) {
      assert.equal(t.relrowsecurity, true, `${t.relname} RLS`);
      assert.equal(t.anon_any, false, `${t.relname} anon privileges`);
    }
  });
});

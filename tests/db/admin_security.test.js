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

const U = () => crypto.randomUUID();
// Every Phase 2A admin RPC with syntactically valid dummy arguments.
const PHASE2A = [
  ['admin_create_session', ['2026-11-03', 'FN', '2026-11-03 08:00', '2026-11-03 10:00']],
  ['admin_update_session', [U(), null]],
  ['admin_set_session_active', [U(), false, 'reason here']],
  ['admin_create_room', ['Z1']],
  ['admin_update_room', [U(), 'Z2']],
  ['admin_set_room_active', [U(), false, 'reason here']],
  ['admin_assign_room_to_session', [U(), U(), 2]],
  ['admin_update_session_room', [U(), 2]],
  ['admin_set_session_room_active', [U(), false, 'reason here']],
  ['admin_remove_session_room', [U(), 'reason here']],
  ['admin_import_begin', ['f.csv', 10, 1]],
  ['admin_import_add_rows', [U(), '[]']],
  ['admin_import_validate', [U()]],
  ['admin_import_preview', [U()]],
  ['admin_import_cancel', [U(), 'reason here']],
  ['admin_import_commit', [U(), true, 'skip']],
  ['admin_import_replace_conflicts', [U(), true, 'reason here']],
];
const call = (client, name, args) =>
  client.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args);

test('configuration and import RPCs are unavailable to the public (anon) role', async () => {
  await withWorld(async (w) => {
    const anon = await w.as('anon');
    for (const [name, args] of PHASE2A) {
      await assert.rejects(call(anon, name, args), (e) => e.code === '42501', name);
    }
  });
});

test('signed-in non-admins and DEACTIVATED admins cannot execute any configuration/import RPC', async () => {
  await withWorld(async (w) => {
    const stranger = await w.as('authenticated', { sub: U() });
    const noSub = await w.as('authenticated');
    const goneId = await w.admin('gone@example.test');
    await w.q('update admins set is_active = false where user_id = $1', [goneId]);
    const gone = await w.as('authenticated', { sub: goneId });
    for (const c of [stranger, noSub, gone]) {
      for (const [name, args] of PHASE2A) {
        await assert.rejects(call(c, name, args), (e) => e.code === '42501' && /not authorized/.test(e.message), name);
      }
    }
    assert.equal((await w.one('select count(*)::int c from exam_sessions')).c, 0);
    assert.equal((await w.one('select count(*)::int c from rooms')).c, 0);
    assert.equal((await w.one('select count(*)::int c from import_batches')).c, 0);
  });
});

test('an admin deactivated mid-session loses access immediately (no cached privilege)', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    assert.equal((await w.rpc(adm, 'admin_create_room', 'ROOM1')).ok, true);
    await w.q('update admins set is_active = false where user_id = $1', [adm.adminId]);
    await assert.rejects(w.rpc(adm, 'admin_create_room', 'ROOM2'), (e) => e.code === '42501');
    assert.equal((await w.one('select count(*)::int c from rooms')).c, 1);
    await w.q('update admins set is_active = true where user_id = $1', [adm.adminId]);
    assert.equal((await w.rpc(adm, 'admin_create_room', 'ROOM2')).ok, true);
  });
});

test('the public role cannot read or write schedule, import, config or audit tables', async () => {
  await withWorld(async (w) => {
    const anon = await w.as('anon');
    for (const t of ['schedule', 'import_batches', 'import_rows', 'exam_sessions', 'rooms', 'session_rooms', 'audit_log', 'app_settings']) {
      await assert.rejects(anon.query(`select * from public.${t}`), (e) => e.code === '42501', 'select ' + t);
    }
    await assert.rejects(anon.query(`insert into public.import_rows (batch_id, row_number) values ($1, 1)`, [U()]), (e) => e.code === '42501');
    await assert.rejects(anon.query(`insert into public.schedule (employee_id, employee_name, department, exam_date, session_label)
                                      values ('E1','n','d','2026-11-03','FN')`), (e) => e.code === '42501');
    await assert.rejects(anon.query(`update public.app_settings set int_value = 1`), (e) => e.code === '42501');
  });
});

test('a signed-in non-admin sees no rows of the new tables; admins can read them but not write them', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    await w.session({ opens: 0, closes: 60 });
    const stranger = await w.as('authenticated', { sub: U() });
    const imp = await w.rpc(adm, 'admin_import_begin', 'f.csv', 10, 1);
    await w.rpc(adm, 'admin_import_add_rows', imp.batch_id, JSON.stringify([{ row: 1, employee_id: 'E1', name: 'N', department: 'D', date: '2026-11-03', session: 'FN' }]));
    for (const t of ['import_batches', 'import_rows', 'exam_sessions', 'audit_log']) {
      assert.equal((await stranger.query(`select count(*)::int c from public.${t}`)).rows[0].c, 0, t + ' hidden from non-admin');
      assert.ok((await adm.query(`select count(*)::int c from public.${t}`)).rows[0].c > 0, t + ' visible to admin');
    }
    await assert.rejects(adm.query(`update public.import_rows set status = 'valid'`), (e) => e.code === '42501');
    await assert.rejects(adm.query(`update public.import_batches set status = 'committed'`), (e) => e.code === '42501');
    await assert.rejects(adm.query(`insert into public.schedule (employee_id, employee_name, department, exam_date, session_label)
                                     values ('E1','n','d','2026-11-03','FN')`), (e) => e.code === '42501');
    await assert.rejects(adm.query(`update public.exam_sessions set is_active = false`), (e) => e.code === '42501');
    await assert.rejects(adm.query(`update public.app_settings set int_value = 1`), (e) => e.code === '42501');
  });
});

test('audit records cannot be updated or deleted by application roles (admins included) nor by the owner', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    await w.rpc(adm, 'admin_create_room', 'A1');
    const anon = await w.as('anon');
    for (const c of [anon, adm]) {
      await assert.rejects(c.query(`update public.audit_log set action = 'x'`), (e) => e.code === '42501');
      await assert.rejects(c.query(`delete from public.audit_log`), (e) => e.code === '42501');
      await assert.rejects(c.query(`truncate public.audit_log`), (e) => e.code === '42501');
      await assert.rejects(c.query(`insert into public.audit_log (actor, action) values ('forged', 'x')`), (e) => e.code === '42501');
    }
    await assert.rejects(w.q(`update audit_log set action = 'x'`), (e) => e.code === '42501');
    await assert.rejects(w.q(`delete from audit_log`), (e) => e.code === '42501');
    assert.equal((await w.q(`select action from audit_log`)).length, 1);
  });
});

test('the admin id in an audit row comes from the JWT, never from an argument', async () => {
  await withWorld(async (w) => {
    const a1 = await w.adminClient('one@example.test');
    const a2 = await w.adminClient('two@example.test');
    await w.rpc(a1, 'admin_create_room', 'ROOM-A');
    await w.rpc(a2, 'admin_create_room', 'ROOM-B');
    const rows = await w.q(`select entity_id, actor, actor_user_id from audit_log order by id`);
    assert.equal(rows[0].actor_user_id, a1.adminId);
    assert.equal(rows[1].actor_user_id, a2.adminId);
    // no Phase 2A function has any admin-id style parameter
    const params = await w.q(`select p.proname, pg_get_function_arguments(p.oid) args from pg_proc p
                                join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname = 'public' and p.proname like 'admin\\_%'`);
    assert.ok(params.length >= 40);
    for (const p of params) assert.ok(!/admin_id|actor|user_id|approved_by|created_by/i.test(p.args), p.proname + ' ' + p.args);
  });
});

test('catalog: every admin function is SECURITY DEFINER, pins search_path, and is executable only by authenticated', async () => {
  await withWorld(async (w) => {
    const fns = await w.q(`
      select p.proname, p.prosecdef, p.proconfig, p.proacl is null as default_acl,
             has_function_privilege('anon', p.oid, 'execute') anon_exec,
             has_function_privilege('authenticated', p.oid, 'execute') auth_exec,
             has_function_privilege('public', p.oid, 'execute') public_exec
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'admin\\_%'`);
    // 7 Phase 1 + 17 Phase 2A + 16 product phase (4 settings/maintenance/diagnostic + 12 read/report). The count is a
    // deliberate closed list: adding an admin function must be a conscious change to this test.
    assert.equal(fns.length, 40, 'admin function count');
    for (const f of fns) {
      assert.equal(f.prosecdef, true, f.proname);
      assert.ok((f.proconfig || []).join(',').includes('search_path=""'), f.proname + ' search_path');
      assert.equal(f.default_acl, false, f.proname);
      assert.equal(f.anon_exec, false, f.proname + ' anon');
      assert.equal(f.public_exec, false, f.proname + ' public');
      assert.equal(f.auth_exec, true, f.proname + ' authenticated');
    }
    const names = fns.map((f) => f.proname);
    for (const [n] of PHASE2A) assert.ok(names.includes(n), n);
    const t = await w.one(`select c.relrowsecurity, has_table_privilege('anon', c.oid, 'select,insert,update,delete') anon_any
                             from pg_class c where c.relname = 'import_rows' and c.relnamespace = 'public'::regnamespace`);
    assert.equal(t.relrowsecurity, true);
    assert.equal(t.anon_any, false);
  });
});

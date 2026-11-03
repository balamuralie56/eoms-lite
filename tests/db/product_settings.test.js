'use strict';
// Migrations 0008/0010: branding, public config, retention/maintenance, client-IP hardening, diagnostics.
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

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('public config is available to anyone and exposes only branding', async () => {
  await withWorld(async (w) => {
    const anon = await w.as('anon');
    const cfg = await w.rpc(anon, 'get_public_config');
    assert.deepEqual(Object.keys(cfg).sort(),
      ['app_title', 'contact_instructions', 'exam_cell_name', 'institution_name', 'logo_data_url', 'support_info']);
    assert.equal(cfg.exam_cell_name, 'Examination Cell');
    await assert.rejects(anon.query('select * from public.app_branding'), (e) => e.code === '42501');
  });
});

test('admin settings: update, partial update, logo handling, validation, audit (without the logo payload)', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    const r = await w.rpc(adm, 'admin_update_settings', ' Test University ', 'Exam Cell A', 'Check-In Desk', PNG, false,
      'Visit room 12.', 'exams@example.test', 50);
    assert.equal(r.ok, true);
    assert.equal(r.institution_name, 'Test University');
    assert.equal(r.logo_data_url, PNG);
    assert.equal(r.default_items_per_page, 50);
    const anon = await w.as('anon');
    assert.equal((await w.rpc(anon, 'get_public_config')).institution_name, 'Test University');

    // NULL = unchanged
    const r2 = await w.rpc(adm, 'admin_update_settings', null, null, 'New Title');
    assert.equal(r2.app_title, 'New Title');
    assert.equal(r2.institution_name, 'Test University');
    assert.equal(r2.logo_data_url, PNG, 'logo kept');
    const cleared = await w.rpc(adm, 'admin_update_settings', null, null, null, null, true);
    assert.equal(cleared.logo_data_url, null);

    const s = await w.rpc(adm, 'admin_get_settings');
    assert.equal(s.institution_name, 'Test University');
    assert.equal(s.retention.retention_attempts_hours, 48);

    const audit = await w.q(`select before, after, actor_user_id from audit_log where action = 'settings.update' order by id`);
    assert.equal(audit.length, 3);
    assert.equal(audit[0].actor_user_id, adm.adminId);
    assert.ok(!JSON.stringify(audit[0]).includes('base64'), 'the logo payload is never copied into the audit log');
    assert.equal(audit[0].after.logo_chars, PNG.length);
    assert.equal(audit[0].before.institution_name, 'Your Institution');
  });
});

test('settings validation: empty names, bad pagination, SVG/non-image/oversized logos and script URLs are refused', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    await rejects(w.rpc(adm, 'admin_update_settings', '   '), '22023', /institution name/);
    await rejects(w.rpc(adm, 'admin_update_settings', null, '  '), '22023', /cell name/);
    await rejects(w.rpc(adm, 'admin_update_settings', null, null, ' '), '22023', /title/);
    await rejects(w.rpc(adm, 'admin_update_settings', null, null, null, null, false, null, null, 5), '22023', /invalid settings/);
    await rejects(w.rpc(adm, 'admin_update_settings', null, null, null, null, false, null, null, 500), '22023', /invalid settings/);
    for (const bad of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'javascript:alert(1)',
      'https://evil.example/logo.png',
      'data:image/png;base64,' + 'A'.repeat(200000),
      'data:image/png;base64,!!!notbase64',
    ]) {
      await rejects(w.rpc(adm, 'admin_update_settings', null, null, null, bad), '22023', /invalid settings/);
    }
    await rejects(w.rpc(adm, 'admin_update_settings', 'x'.repeat(121)), '22023', /invalid settings/);
    assert.equal((await w.rpc(adm, 'admin_get_settings')).institution_name, 'Your Institution', 'nothing changed');
    assert.equal((await w.q(`select 1 from audit_log where action = 'settings.update'`)).length, 0);
  });
});

test('settings and maintenance RPCs refuse non-admins; the diagnostic never echoes credentials', async () => {
  await withWorld(async (w) => {
    const anon = await w.as('anon');
    const stranger = await w.as('authenticated', { sub: crypto.randomUUID() });
    for (const [n, args] of [['admin_get_settings', []], ['admin_update_settings', ['X']], ['admin_run_maintenance', []], ['admin_debug_request_headers', []]]) {
      await assert.rejects(w.rpc(anon, n, ...args), (e) => e.code === '42501', n + ' anon');
      await assert.rejects(w.rpc(stranger, n, ...args), (e) => e.code === '42501' && /not authorized/.test(e.message), n + ' stranger');
    }
    const adm = await w.adminClient();
    await adm.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({
      authorization: 'Bearer SECRET', apikey: 'KEY', cookie: 'c=1', 'cf-connecting-ip': '203.0.113.5', 'user-agent': 'ua' })]);
    const d = await w.rpc(adm, 'admin_debug_request_headers');
    assert.equal(d.headers.authorization, undefined);
    assert.equal(d.headers.apikey, undefined);
    assert.equal(d.headers.cookie, undefined);
    assert.equal(d.headers['cf-connecting-ip'], '203.0.113.5');
    assert.match(d.client_ip_hash_used, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(d).includes('SECRET'));
  });
});

test('throttle cannot be dodged by forging the LEFT-most X-Forwarded-For entry; cf-connecting-ip is preferred', async () => {
  await withWorld(async (w) => {
    const s = await w.session();
    await w.rooms(s, [2]);
    await w.q(`update app_settings set int_value = 3 where key = 'throttle_max_failures'`);
    // attacker rotates a forged first entry; the trusted proxy appends the real peer last
    const attacker = await w.as('anon');
    for (let i = 0; i < 3; i++) {
      await attacker.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-forwarded-for': `198.51.100.${i}, 203.0.113.77` })]);
      assert.equal((await w.checkin(attacker, 'GHOST' + i)).code, 'NOT_SCHEDULED');
    }
    await attacker.query(`select set_config('request.headers', $1, false)`, [JSON.stringify({ 'x-forwarded-for': '198.51.100.99, 203.0.113.77' })]);
    assert.equal((await w.checkin(attacker, 'GHOST9')).code, 'RATE_LIMITED', 'same real peer, different forged prefix');

    // cf-connecting-ip wins over XFF
    const viaCf = await w.as('anon', { headers: { 'cf-connecting-ip': '203.0.113.200', 'x-forwarded-for': '203.0.113.77' } });
    assert.equal((await w.checkin(viaCf, 'GHOST1')).code, 'NOT_SCHEDULED', 'different cf IP is not throttled');
  });
});

test('maintenance: deletes old throttle records and abandoned staging; NEVER touches the audit log; admin run is audited', async () => {
  await withWorld(async (w) => {
    const adm = await w.adminClient();
    await w.session({ date: '2026-11-03', label: 'FN', opens: 0, closes: 60 });

    await w.q(`insert into check_attempts (at, ip_hash, outcome) values
                 (now() - interval '3 days', 'old', 'NOT_SCHEDULED'), (now() - interval '1 hour', 'new', 'NOT_SCHEDULED')`);

    const mk = async (name) => {
      const b = await w.rpc(adm, 'admin_import_begin', name, 10, 1);
      await w.rpc(adm, 'admin_import_add_rows', b.batch_id, JSON.stringify([{ row: 1, employee_id: 'E1', name: 'N', department: 'D', date: '2026-11-03', session: 'FN' }]));
      await w.rpc(adm, 'admin_import_validate', b.batch_id);
      return b.batch_id;
    };
    const stale = await mk('stale.csv');
    const fresh = await mk('fresh.csv');
    const committed = await mk('committed.csv');
    await w.rpc(adm, 'admin_import_commit', committed, true);
    await w.q(`update import_batches set uploaded_at = now() - interval '10 days' where id = $1`, [stale]);
    await w.q(`update import_batches set uploaded_at = now() - interval '200 days', committed_at = now() - interval '200 days' where id = $1`, [committed]);

    const auditBefore = (await w.one('select count(*)::int c from audit_log')).c;
    const res = await w.rpc(adm, 'admin_run_maintenance');
    assert.equal(res.ok, true);
    assert.equal(res.check_attempts_deleted, 1);
    assert.equal(res.abandoned_batches_cancelled, 1);
    assert.equal(res.old_import_rows_deleted, 1);

    assert.deepEqual((await w.q('select ip_hash from check_attempts')).map((r) => r.ip_hash), ['new']);
    const st = Object.fromEntries((await w.q('select id, status from import_batches')).map((r) => [r.id, r.status]));
    assert.equal(st[stale], 'cancelled');
    assert.equal(st[fresh], 'validated', 'a recent staging batch is kept');
    assert.equal(st[committed], 'committed');
    assert.equal((await w.q('select 1 from import_rows where batch_id = $1', [stale])).length, 0);
    assert.equal((await w.q('select 1 from import_rows where batch_id = $1', [fresh])).length, 1);
    assert.equal((await w.q('select 1 from import_rows where batch_id = $1', [committed])).length, 0, 'old committed staging rows purged');
    assert.equal((await w.q('select 1 from schedule')).length, 1, 'the live schedule is untouched');

    const audit = await w.q(`select action, actor from audit_log order by id`);
    assert.ok(audit.length > auditBefore, 'audit only grows');
    assert.ok(audit.some((a) => a.action === 'import.abandoned_cleanup' && a.actor === 'system'));
    assert.ok(audit.some((a) => a.action === 'maintenance.run' && a.actor === 'admin:' + adm.adminId));
    // owner/pg_cron entry point works without a JWT and is not exposed to API roles
    const sys = await w.one(`select eoms_private.run_maintenance() r`);
    assert.equal(sys.r.check_attempts_deleted, 0);
    const anon = await w.as('anon');
    await assert.rejects(anon.query('select eoms_private.run_maintenance()'), (e) => e.code === '42501');
  });
});

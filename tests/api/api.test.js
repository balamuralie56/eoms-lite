'use strict';
// Integration through the real PostgREST Data API (local Docker). Proves RPC parameter shapes, status mapping,
// JWT handling and request headers as PostgREST sees them. It does NOT prove Supabase's gateway/Auth behaviour.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./stack');

before(S.startStack);
after(S.stopStack);
beforeEach(S.reset);

const tokenFor = async (email) => {
  await S.createAdmin(email);
  const l = await S.login(email, 'pw-' + email);
  assert.equal(l.status, 200);
  return l.body.access_token;
};

test('anonymous status and branding calls work with JSON named parameters', async () => {
  const st = await S.rpc('get_checkin_status', {});
  assert.equal(st.status, 200);
  assert.equal(st.body.state, 'CLOSED');
  const cfg = await S.rpc('get_public_config', {});
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.exam_cell_name, 'Examination Cell');
  await S.seedOpenSession();
  assert.equal((await S.rpc('get_checkin_status', {})).body.state, 'OPEN');
});

test('anonymous check-in over HTTP: allocation, idempotent retry, rejection codes', async () => {
  const { ids } = await S.seedOpenSession({ caps: [2, 2], employees: 3 });
  const a = await S.rpc('checkin', { p_employee_id: ' ' + ids[0].toLowerCase() + ' ' });
  assert.equal(a.status, 200);
  assert.equal(a.body.code, 'ALLOCATED');
  assert.equal(a.body.employee_id, ids[0]);
  const again = await S.rpc('checkin', { p_employee_id: ids[0] });
  assert.equal(again.body.code, 'ALREADY_ALLOCATED');
  assert.equal(again.body.room_code, a.body.room_code);
  assert.equal((await S.rpc('checkin', { p_employee_id: 'NOBODY' })).body.code, 'NOT_SCHEDULED');
  assert.equal((await S.rpc('checkin', { p_employee_id: 'bad id!' })).body.code, 'INVALID_ID');
  assert.equal((await S.rpc('checkin', { p_employee_id: null })).body.code, 'INVALID_ID');
  // a MISSING required parameter never reaches the function: PostgREST answers 404 PGRST202 (the frontend always sends it)
  const missing = await S.rpc('checkin', {});
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'PGRST202');
});

test('the public (anon) role cannot read tables or call admin RPCs through the Data API', async () => {
  await S.seedOpenSession();
  for (const t of ['schedule', 'allocations', 'audit_log', 'admins', 'exam_sessions', 'import_rows', 'app_branding']) {
    const r = await fetch(`${S.BASE}/rest/v1/${t}?select=*`, { headers: { apikey: 'x' } });
    assert.ok([401, 403].includes(r.status), `${t}: ${r.status}`);
    const j = await r.json();
    assert.ok(Array.isArray(j) === false, `${t} must not return rows`);
  }
  for (const fn of ['admin_overview', 'admin_list_schedule', 'admin_create_room', 'admin_import_begin', 'admin_report']) {
    const r = await S.rpc(fn, {});
    assert.ok([401, 403, 404].includes(r.status), `${fn}: ${r.status}`);
    assert.notEqual(r.status, 200);
  }
});

test('a signed-in NON-admin gets "not authorized" (403); an active admin succeeds; JWT is verified', async () => {
  const email = 'nonadmin@example.test';
  await S.createAdmin(email, 'pw', { admin: false });
  const na = (await S.login(email, 'pw')).body.access_token;
  const r = await S.rpc('admin_overview', {}, na);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, '42501');
  assert.match(r.body.message, /not authorized/);

  const admin = await tokenFor('boss@example.test');
  const ok = await S.rpc('admin_overview', {}, admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, 'NONE');

  const forged = admin.slice(0, -4) + 'AAAA';
  assert.equal((await S.rpc('admin_overview', {}, forged)).status, 401);
  assert.equal((await S.rpc('admin_overview', {}, 'not-a-jwt')).status, 401);
});

test('an expired access token is rejected by the Data API (PostgREST applies some clock-skew leeway: a token 2 s past expiry was still accepted)', async () => {
  await S.post('/__test/ttl', { seconds: -300 });                       // issued already 5 minutes expired
  const t = await tokenFor('expired@example.test');
  const r = await S.rpc('admin_overview', {}, t);
  assert.equal(r.status, 401);
  assert.match(JSON.stringify(r.body), /JWT expired/i);
});

test('deactivating an admin takes effect immediately even with a still-valid token', async () => {
  const t = await tokenFor('soon-gone@example.test');
  assert.equal((await S.rpc('admin_overview', {}, t)).status, 200);
  await S.sql(`update admins set is_active = false where email = 'soon-gone@example.test'`);
  const r = await S.rpc('admin_overview', {}, t);
  assert.equal(r.status, 403);
});

test('PostgREST status mapping of database errors (what the frontend must handle)', async () => {
  const t = await tokenFor('map@example.test');
  const bad = await S.rpc('admin_create_room', { p_room_code: '   ' }, t);
  assert.equal(bad.status, 400);                                  // 22023
  assert.equal(bad.body.code, '22023');
  assert.match(bad.body.message, /room code is required/);
  await S.rpc('admin_create_room', { p_room_code: 'DUP' }, t);
  const dup = await S.rpc('admin_create_room', { p_room_code: 'dup' }, t);
  assert.equal(dup.status, 409);                                  // 23505
  assert.equal(dup.body.code, '23505');
  const unknown = await S.rpc('admin_report', { p_report: 'nope' }, t);
  assert.equal(unknown.status, 400);
  const missing = await S.rpc('no_such_function', {}, t);
  assert.equal(missing.status, 404);
});

test('parameter shapes the frontend uses: JSON arrays for jsonb, nulls for defaults, booleans, ISO timestamps', async () => {
  const t = await tokenFor('shape@example.test');
  const sess = await S.rpc('admin_create_session', {
    p_exam_date: '2026-11-03', p_session_label: 'FN', p_opens_local: '2026-11-03 08:00', p_closes_local: '2026-11-03 10:00' }, t);
  assert.equal(sess.status, 200);
  assert.equal(sess.body.session.checkin_opens_at_ist, '2026-11-03 08:00');
  const b = await S.rpc('admin_import_begin', { p_filename: 'f.csv', p_file_size_bytes: 100, p_declared_rows: 1 }, t);
  const add = await S.rpc('admin_import_add_rows', { p_batch_id: b.body.batch_id,
    p_rows: [{ row: 1, employee_id: 1001, name: 'N', department: 'D', date: '2026-11-03', session: 'FN' }] }, t);   // real JSON array, number id
  assert.equal(add.status, 200);
  assert.equal(add.body.staged_rows, 1);
  const val = await S.rpc('admin_import_validate', { p_batch_id: b.body.batch_id }, t);
  assert.equal(val.body.summary.valid, 1);
  const commit = await S.rpc('admin_import_commit', { p_batch_id: b.body.batch_id, p_confirm: true, p_on_conflict: null }, t);
  assert.equal(commit.body.ok, true);
  const audit = await S.rpc('admin_list_audit', { p_from: '2020-01-01T00:00:00Z', p_to: '2100-01-01T00:00:00Z', p_limit: 100 }, t);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.total >= 4);
  const sch = await S.rpc('admin_list_schedule', { p_search: '1001', p_status: null, p_limit: 10, p_offset: 0 }, t);
  assert.equal(sch.body.total, 1);
});

test('a 500-row chunk is accepted through the Data API; a full 5000-row import works end to end over HTTP', async () => {
  const t = await tokenFor('import@example.test');
  await S.rpc('admin_create_session', { p_exam_date: '2026-11-03', p_session_label: 'FN', p_opens_local: '2026-11-03 08:00', p_closes_local: '2026-11-03 10:00' }, t);
  const rows = Array.from({ length: 5000 }, (_, i) => ({ row: i + 2, employee_id: 'EMP' + String(i + 1).padStart(5, '0'),
    name: 'Employee ' + (i + 1), department: 'DEPT' + (i % 30), date: '03/11/2026', session: 'Forenoon' }));
  const t0 = Date.now();
  const b = await S.rpc('admin_import_begin', { p_filename: 'big.xlsx', p_file_size_bytes: 400000, p_declared_rows: 5000 }, t);
  for (let i = 0; i < rows.length; i += 500) {
    const r = await S.rpc('admin_import_add_rows', { p_batch_id: b.body.batch_id, p_rows: rows.slice(i, i + 500) }, t);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  }
  const v = await S.rpc('admin_import_validate', { p_batch_id: b.body.batch_id }, t);
  assert.equal(v.body.summary.valid, 5000);
  const c = await S.rpc('admin_import_commit', { p_batch_id: b.body.batch_id, p_confirm: true, p_on_conflict: 'skip' }, t);
  assert.equal(c.body.ok, true);
  console.log(`# 5000-row import over local HTTP (PostgREST, Docker): total ${Date.now() - t0}ms for begin + 10 chunks + validate + commit`);
  assert.equal((await S.sql('select count(*)::int c from schedule'))[0].c, 5000);
  const over = await S.rpc('admin_import_add_rows', { p_batch_id: b.body.batch_id, p_rows: rows.slice(0, 501) }, t);
  assert.ok([400, 409].includes(over.status));
});

test('PostgREST passes request headers into the database (needed by the throttle); credentials are never echoed', async () => {
  const t = await tokenFor('hdr@example.test');
  const r = await S.rpc('admin_debug_request_headers', {}, t, { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '198.51.100.7' });
  assert.equal(r.status, 200);
  assert.equal(r.body.headers['x-forwarded-for'].includes('203.0.113.9'), true);
  assert.equal(r.body.headers['cf-connecting-ip'], '198.51.100.7');
  assert.equal(r.body.headers.authorization, undefined);
  assert.equal(r.body.headers.apikey, undefined);
  assert.match(r.body.client_ip_hash_used, /^[0-9a-f]{64}$/);
});

test('100 simultaneous HTTP check-ins: no duplicates, no over-capacity (latency here is LOCAL, not Supabase)', async () => {
  const { ids, session } = await S.seedOpenSession({ caps: Array(10).fill(10), employees: 100 });   // exactly 100 slots
  const calls = ids.concat(ids.slice(0, 50));                 // 100 employees + 50 simultaneous duplicate submissions
  const t0 = Date.now();
  const res = await Promise.all(calls.map((id) => S.rpc('checkin', { p_employee_id: id })));
  const wall = Date.now() - t0;
  const lat = res.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.ceil(q * lat.length) - 1)].toFixed(0);
  console.log(`# ${res.length} concurrent HTTP check-ins (local): wall=${wall}ms p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms`);
  assert.ok(res.every((r) => r.status === 200));
  const codes = res.reduce((m, r) => ((m[r.body.code] = (m[r.body.code] || 0) + 1), m), {});
  assert.equal(codes.ALLOCATED, 100, JSON.stringify(codes));
  assert.equal(codes.ALREADY_ALLOCATED, 50, JSON.stringify(codes));
  const active = await S.sql(`select count(*)::int c from allocations where session_id = $1 and released_at is null`, [session.id]);
  const distinct = await S.sql(`select count(distinct employee_id)::int c from allocations where session_id = $1`, [session.id]);
  assert.equal(active[0].c, distinct[0].c, 'one active allocation per employee');
  assert.equal(active[0].c, 100);
  const over = await S.sql(`select 1 from session_rooms sr join allocations a on a.session_room_id = sr.id and a.released_at is null
                              group by sr.id, sr.max_invigilators having count(*) > sr.max_invigilators`);
  assert.equal(over.length, 0);
  assert.equal(codes.BUSY || 0, 0);
  assert.equal(codes.RATE_LIMITED || 0, 0);
});

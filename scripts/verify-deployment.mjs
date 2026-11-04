// Smoke test for a deployed project, over the public API (what a browser can do). Safe: it only READS.
//
//   (PowerShell)  $env:SUPABASE_URL = "https://<ref>.supabase.co"
//                 $env:SUPABASE_ANON_KEY = "<anon public key>"
//                 node scripts/verify-deployment.mjs
//   Optional, to also verify an administrator end to end and show which client-IP header the platform passes
//   (needed by the abuse throttle):  $env:ADMIN_EMAIL, $env:ADMIN_PASSWORD
//
// Never put the service_role key here: the script refuses it. Credentials are read from the environment only and never printed.
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_ANON_KEY || '';
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(URL_);
if (!URL_ || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY in the environment.'); process.exit(2); }
if (!isLocal && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(URL_)) { console.error('SUPABASE_URL must be https://<project-ref>.supabase.co'); process.exit(2); }

// Supabase has two key formats: the newer "sb_publishable_..." / "sb_secret_..." keys and the legacy JWT anon / service_role keys.
const keyKind = KEY.startsWith('sb_publishable_') ? 'publishable' : KEY.startsWith('sb_secret_') ? 'secret' : 'jwt';
let role = '';
if (keyKind === 'jwt') { try { role = JSON.parse(Buffer.from(KEY.split('.')[1], 'base64url').toString()).role; } catch { /* not a JWT */ } }
if (keyKind === 'secret' || role === 'service_role') {
  console.error('REFUSING: that is a SECRET key (sb_secret_... or service_role). It must never leave the server. Use the publishable / anon key.');
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };
const call = async (path, { method = 'GET', body, token = KEY, headers = {} } = {}) => {
  const r = await fetch(URL_ + path, { method, headers: { apikey: KEY, authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: r.status, body: j };
};
const denied = (r) => [401, 403, 404, 406].includes(r.status) && !(Array.isArray(r.body) && r.body.length);

check('key is a public key (publishable, or legacy JWT anon)', keyKind === 'publishable' || role === 'anon',
  keyKind === 'publishable' ? 'sb_publishable_ key' : `legacy JWT role=${role || 'unknown'}`);

const st = await call('/rest/v1/rpc/get_checkin_status', { method: 'POST', body: {} });
check('public: get_checkin_status answers', st.status === 200 && ['OPEN', 'CLOSED'].includes(st.body?.state), `state=${st.body?.state}`);
const cfg = await call('/rest/v1/rpc/get_public_config', { method: 'POST', body: {} });
check('public: get_public_config exposes branding only', cfg.status === 200 && Object.keys(cfg.body ?? {}).sort().join() === 'app_title,contact_instructions,exam_cell_name,institution_name,logo_data_url,support_info');

for (const t of ['schedule', 'allocations', 'audit_log', 'admins', 'exam_sessions', 'rooms', 'session_rooms', 'import_rows', 'import_batches', 'admin_authorizations', 'employee_flags', 'check_attempts', 'app_branding', 'app_settings']) {
  const r = await call(`/rest/v1/${t}?select=*&limit=1`);
  check(`anonymous cannot read table ${t}`, denied(r), `HTTP ${r.status}`);
}
for (const fn of ['admin_overview', 'admin_list_schedule', 'admin_list_audit', 'admin_create_room', 'admin_import_begin', 'admin_run_maintenance', 'admin_debug_request_headers']) {
  const r = await call(`/rest/v1/rpc/${fn}`, { method: 'POST', body: {} });
  check(`anonymous cannot call ${fn}`, r.status !== 200 && r.status < 500, `HTTP ${r.status}`);
}
const priv = await call('/rest/v1/rpc/run_maintenance', { method: 'POST', body: {}, headers: { 'content-profile': 'eoms_private' } });
check('schema eoms_private is not exposed through the API', priv.status !== 200 && priv.status < 500, `HTTP ${priv.status}`);

const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
if (email && password) {
  const login = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  const token = login.body?.access_token;
  check('admin can sign in with Supabase Auth', login.status === 200 && Boolean(token), `HTTP ${login.status}`);
  if (token) {
    const isAdmin = await call('/rest/v1/rpc/is_admin', { method: 'POST', body: {}, token });
    check('admin is recognised by the database (is_admin)', isAdmin.status === 200 && isAdmin.body === true, `HTTP ${isAdmin.status} -> ${JSON.stringify(isAdmin.body)}`);
    const ov = await call('/rest/v1/rpc/admin_overview', { method: 'POST', body: {}, token });
    check('admin can call admin_overview', ov.status === 200 && ov.body?.state !== undefined, `HTTP ${ov.status}`);
    const hd = await call('/rest/v1/rpc/admin_debug_request_headers', { method: 'POST', body: {}, token });
    if (hd.status === 200) {
      const names = Object.keys(hd.body.headers ?? {}).sort();
      console.log(`INFO  request headers seen by the database: ${names.join(', ')}`);
      check('a client-IP header reaches the database (the abuse throttle needs one)', Boolean(hd.body.client_ip_hash_used), hd.body.client_ip_hash_used ? 'cf-connecting-ip or X-Forwarded-For present' : 'NONE: the throttle is INACTIVE until this is resolved');
    }
  }
} else console.log('INFO  skipped the administrator checks (set ADMIN_EMAIL and ADMIN_PASSWORD to include them)');

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

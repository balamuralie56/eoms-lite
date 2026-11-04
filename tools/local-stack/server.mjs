// LOCAL TEST STACK ONLY. A tiny Supabase-shaped front door:
//   /rest/v1/*   -> PostgREST (real Data API engine, real database)
//   /auth/v1/*   -> a MINIMAL STAND-IN for Supabase Auth (GoTrue): password login, refresh, user, logout.
//   /__test/*    -> test helpers (reset database, create admins). Refused unless EOMS_LOCAL_STACK=1.
// This is NOT Supabase. It exists so the real frontend + real RPCs + real PostgREST can be exercised end to end.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

if (process.env.EOMS_LOCAL_STACK !== '1' && !process.argv.includes('--local-test-stack')) {
  console.error('Pass --local-test-stack (or set EOMS_LOCAL_STACK=1) to confirm this is the local test stack.');
  process.exit(1);
}
const PORT = Number(process.env.STACK_PORT || 54321);
const POSTGREST = { host: '127.0.0.1', port: Number(process.env.POSTGREST_PORT || 3010) };
const JWT_SECRET = process.env.PGRST_JWT_SECRET || 'e2e-only-jwt-secret-0123456789abcdef0123456789';
const DB_URL = process.env.E2E_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:54329/eoms_e2e';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB_URL)) { console.error('non-local database refused'); process.exit(1); }

const b64u = (b) => Buffer.from(b).toString('base64url');
function signJwt(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  const [h, b, s] = (token || '').split('.');
  if (!h || !b || !s) return null;
  const exp = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
  if (exp !== s) return null;
  const p = JSON.parse(Buffer.from(b, 'base64url').toString());
  return p.exp && p.exp * 1000 < Date.now() ? null : p;
}

/**
 * email -> { id, password } (tests, in memory) or { id, salt, hash } (when STACK_USERS_FILE is set: persisted with scrypt,
 * never in clear). refresh token -> email (in memory: a restart simply asks people to sign in again).
 */
const users = new Map();
const refresh = new Map();
let accessTtl = 3600;

const USERS_FILE = process.env.STACK_USERS_FILE || null;
const TEST_ENDPOINTS = process.env.STACK_DISABLE_TEST_ENDPOINTS !== '1';
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') });
const passwordOk = (u, pw) => {
  if (typeof pw !== 'string') return false;
  if (u.password !== undefined) return u.password === pw;
  return crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), crypto.scryptSync(pw, u.salt, 32));
};
const persistUsers = () => {
  if (USERS_FILE) fs.writeFileSync(USERS_FILE, JSON.stringify([...users].map(([email, u]) => ({ email, ...u }))));
};
if (USERS_FILE && fs.existsSync(USERS_FILE)) {
  for (const { email, ...u } of JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))) users.set(email, u);
}

function session(email) {
  const u = users.get(email);
  const now = Math.floor(Date.now() / 1000);
  const access = signJwt({ aud: 'authenticated', role: 'authenticated', sub: u.id, email, iat: now, exp: now + accessTtl });
  const rt = crypto.randomBytes(12).toString('hex');
  refresh.set(rt, email);
  return {
    access_token: access, token_type: 'bearer', expires_in: accessTtl, expires_at: now + accessTtl, refresh_token: rt,
    user: { id: u.id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}

const CORS = (req) => ({
  'access-control-allow-origin': req.headers.origin || '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': req.headers['access-control-request-headers'] || 'authorization,apikey,content-type,x-client-info,prefer,accept-profile,content-profile',
  'access-control-expose-headers': 'content-range,content-type',
  'access-control-max-age': '600',
  vary: 'origin',
});

const readBody = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
const json = (req, res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...CORS(req) }); res.end(JSON.stringify(obj)); };

const TABLES = ['allocations', 'admin_authorizations', 'employee_flags', 'check_attempts', 'audit_log', 'import_rows',
  'import_batches', 'schedule', 'session_rooms', 'rooms', 'exam_sessions', 'admins'];

async function resetDb() {
  const c = new pg.Client({ connectionString: DB_URL });
  await c.connect();
  try {
    // immutability triggers are skipped under replica role: this is the TEST harness resetting a throwaway database
    await c.query('set session_replication_role = replica');
    await c.query(`truncate ${TABLES.join(', ')} restart identity cascade`);
    await c.query(`update app_settings set int_value = case key
        when 'throttle_max_failures' then 60 when 'throttle_window_seconds' then 600 when 'import_max_file_bytes' then 5242880
        when 'import_max_rows' then 5000 when 'import_chunk_max_rows' then 500 when 'retention_attempts_hours' then 48
        when 'retention_staging_days' then 7 when 'retention_committed_rows_days' then 90 else int_value end`);
    await c.query(`update app_branding set institution_name = 'Your Institution', exam_cell_name = 'Examination Cell',
        app_title = 'Invigilator Check-In', logo_data_url = null, contact_instructions = 'Please contact the examination cell.',
        support_info = null, default_items_per_page = 25 where id = 1`);
  } finally { await c.end(); }
  users.clear(); refresh.clear(); accessTtl = 3600; persistUsers();
}

async function addAdmin({ email, password, active = true, admin = true }) {
  const id = crypto.randomUUID();
  users.set(email, USERS_FILE ? { id, ...hashPw(password) } : { id, password });
  persistUsers();
  if (admin) {
    const c = new pg.Client({ connectionString: DB_URL });
    await c.connect();
    try { await c.query('insert into admins (user_id, email, display_name, is_active) values ($1, $2, $3, $4)', [id, email, email.split('@')[0], active]); }
    finally { await c.end(); }
  }
  return id;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS(req)); return res.end(); }

  if (url.pathname.startsWith('/rest/v1/')) {
    const body = await readBody(req);
    const headers = { ...req.headers, host: `${POSTGREST.host}:${POSTGREST.port}`, 'content-length': body.length };
    delete headers.origin;
    // behave like a trusted reverse proxy: APPEND the real peer address (the client may have forged earlier entries)
    const peer = req.socket.remoteAddress || '';
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${peer}` : peer;
    const pr = http.request({ ...POSTGREST, method: req.method, path: url.pathname.slice('/rest/v1'.length) + url.search, headers }, (r) => {
      res.writeHead(r.statusCode, { ...r.headers, ...CORS(req) });
      r.pipe(res);
    });
    pr.on('error', (e) => json(req, res, 502, { message: 'PostgREST unreachable: ' + e.message }));
    return pr.end(body);
  }

  if (url.pathname === '/auth/v1/token' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const u = users.get(String(body.email || '').toLowerCase()) || users.get(body.email);
      if (!u || !passwordOk(u, body.password)) {
        return json(req, res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      return json(req, res, 200, session(body.email));
    }
    if (grant === 'refresh_token') {
      const email = refresh.get(body.refresh_token);
      if (!email) return json(req, res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      refresh.delete(body.refresh_token);
      return json(req, res, 200, session(email));
    }
    return json(req, res, 400, { msg: 'unsupported grant_type' });
  }
  if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
    const p = verifyJwt((req.headers.authorization || '').replace(/^Bearer /i, ''));
    if (!p) return json(req, res, 401, { code: 401, msg: 'invalid JWT' });
    return json(req, res, 200, { id: p.sub, aud: 'authenticated', role: 'authenticated', email: p.email, app_metadata: {}, user_metadata: {} });
  }
  if (url.pathname === '/auth/v1/logout') { res.writeHead(204, CORS(req)); return res.end(); }

  if (url.pathname.startsWith('/__test/') && !TEST_ENDPOINTS) return json(req, res, 404, { message: 'not found' });   // permanent/demo mode: no reset/admin helpers
  if (url.pathname.startsWith('/__test/')) {
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {};
    try {
      if (url.pathname === '/__test/reset') { await resetDb(); return json(req, res, 200, { ok: true }); }
      if (url.pathname === '/__test/admin') { return json(req, res, 200, { ok: true, id: await addAdmin(body) }); }
      if (url.pathname === '/__test/ttl') { accessTtl = Number(body.seconds) || 3600; return json(req, res, 200, { ok: true }); }
      if (url.pathname === '/__test/health') { return json(req, res, 200, { ok: true }); }
    } catch (e) { return json(req, res, 500, { error: String(e.message || e) }); }
  }
  json(req, res, 404, { message: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`local stack on http://127.0.0.1:${PORT} (rest -> PostgREST :${POSTGREST.port}; auth = stand-in)`));

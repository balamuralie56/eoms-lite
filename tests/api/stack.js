'use strict';
// Helpers for tests that go through the LOCAL stack: browser-shaped HTTP -> stand-in front door -> PostgREST -> PostgreSQL.
// Requires `npm run stack:up` (database eoms_e2e + PostgREST container). Auth is a stand-in, NOT Supabase Auth.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const BASE = process.env.STACK_URL || 'http://127.0.0.1:54321';
const DB_URL = process.env.E2E_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:54329/eoms_e2e';
let child = null;

async function alive() {
  try { const r = await fetch(BASE + '/__test/health'); return r.ok; } catch { return false; }
}

async function startStack() {
  if (await alive()) return;
  child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'tools', 'local-stack', 'server.mjs'), '--local-test-stack'],
    { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { if (await alive()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('local stack did not start');
}
function stopStack() { if (child) child.kill(); child = null; }

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
const reset = () => post('/__test/reset');
const createAdmin = (email, password = 'pw-' + email, extra = {}) => post('/__test/admin', { email, password, ...extra });

/** Anon key shaped like Supabase's: a JWT with role "anon" signed with the project secret (supabase-js sends it as a Bearer token). */
const JWT_SECRET = process.env.PGRST_JWT_SECRET || 'e2e-only-jwt-secret-0123456789abcdef0123456789';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function anonKey() {
  const head = b64u({ alg: 'HS256', typ: 'JWT' });
  const body = b64u({ role: 'anon', iss: 'local-test-stack', iat: 1700000000, exp: 4102444800 });
  return `${head}.${body}.${require('node:crypto').createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

/** Calls /rest/v1/rpc/<fn> like supabase-js does: always apikey + Authorization (the anon key when signed out). */
async function rpc(fn, args = {}, token = null, extraHeaders = {}) {
  const t0 = process.hrtime.bigint();
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: anonKey(), authorization: 'Bearer ' + (token || anonKey()), ...extraHeaders },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, body, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

async function login(email, password) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  return { status: r.status, body: await r.json() };
}

async function sql(text, params) {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try { return (await c.query(text, params)).rows; } finally { await c.end(); }
}

/** Open session (window around now, IST date) with rooms and scheduled employees; returns ids. */
async function seedOpenSession({ caps = [3, 3], employees = 6, prefix = 'E' } = {}) {
  const [s] = await sql(`insert into exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at)
      values ((now() at time zone 'Asia/Kolkata')::date, 'FN', now() - interval '30 minutes', now() + interval '30 minutes') returning *`);
  for (let i = 0; i < caps.length; i++) {
    const [r] = await sql(`insert into rooms (room_code, building, floor) values ($1, 'Main', '1') returning id`, [`R${i + 1}`]);
    await sql(`insert into session_rooms (session_id, room_id, max_invigilators) values ($1, $2, $3)`, [s.id, r.id, caps[i]]);
  }
  const ids = Array.from({ length: employees }, (_, i) => `${prefix}${String(i + 1).padStart(4, '0')}`);
  await sql(`insert into schedule (employee_id, employee_name, department, exam_date, session_label)
             select x, 'Name ' || x, 'CSE', $2::date, 'FN' from unnest($1::text[]) x`, [ids, s.exam_date]);
  return { session: s, ids };
}

module.exports = { anonKey, BASE, startStack, stopStack, reset, createAdmin, rpc, login, sql, post, seedOpenSession };

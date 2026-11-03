'use strict';
// Test harness: real PostgreSQL (docker compose `db`), migrations applied verbatim,
// one throwaway database per test (cloned from a per-process template for speed).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:54329/postgres';
const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();

function withDb(url, db) {
  const u = new URL(url);
  u.pathname = '/' + db;
  return u.toString();
}

async function adminQuery(sql) {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}

let templateName = null;

async function buildTemplate() {
  templateName = 'eoms_tpl_' + crypto.randomBytes(4).toString('hex');
  await adminQuery(`create database ${templateName}`);
  const c = new Client({ connectionString: withDb(ADMIN_URL, templateName) });
  await c.connect();
  try {
    await c.query(fs.readFileSync(path.join(__dirname, '00_supabase_shim.sql'), 'utf8'));
    for (const f of MIGRATIONS) {
      await c.query(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8'));
    }
  } finally {
    await c.end();
  }
}

async function dropTemplate() {
  if (templateName) await adminQuery(`drop database if exists ${templateName} with (force)`);
  templateName = null;
}

class World {
  constructor(name, owner) {
    this.name = name;
    this.url = withDb(ADMIN_URL, name);
    this.owner = owner;          // superuser connection (bypasses RLS) - used only for seeding/inspection
    this.clients = [];
    this.pools = [];
  }

  static async create() {
    if (!templateName) throw new Error('call buildTemplate() in before()');
    const name = 'eoms_t_' + crypto.randomBytes(5).toString('hex');
    await adminQuery(`create database ${name} template ${templateName}`);
    const owner = new Client({ connectionString: withDb(ADMIN_URL, name) });
    await owner.connect();
    return new World(name, owner);
  }

  async close() {
    for (const p of this.pools) await p.end().catch(() => {});
    for (const c of this.clients) await c.end().catch(() => {});
    await this.owner.end().catch(() => {});
    await adminQuery(`drop database if exists ${this.name} with (force)`);
  }

  q(sql, params) { return this.owner.query(sql, params).then((r) => r.rows); }
  async one(sql, params) { return (await this.q(sql, params))[0]; }

  /** A connection acting as the given Postgres role, optionally with a JWT subject (admin uuid). */
  async as(role, { sub, headers } = {}) {
    const c = new Client({ connectionString: this.url });
    await c.connect();
    this.clients.push(c);
    await c.query(`set role ${role}`);
    if (sub) await c.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub, role })]);
    if (headers) await c.query(`select set_config('request.headers', $1, false)`, [JSON.stringify(headers)]);
    return c;
  }

  /** Pool of anon connections for concurrency tests. */
  anonPool(max, headers) {
    const pool = new Pool({ connectionString: this.url, max });
    pool.on('connect', (client) => {
      client.query('set role anon');
      if (headers) client.query(`select set_config('request.headers', $1, false)`, [JSON.stringify(headers)]);
    });
    this.pools.push(pool);
    return pool;
  }

  // ---- seeding (as owner) -------------------------------------------------

  async admin(email = 'admin@example.test') {
    const id = crypto.randomUUID();
    await this.q(`insert into admins (user_id, email, display_name) values ($1, $2, $3)`, [id, email, email]);
    return id;
  }

  /** window = minutes relative to now(): [opens, closes). */
  async session({ label = 'FN', date = '2026-11-03', opens = -30, closes = 30, active = true } = {}) {
    return this.one(
      `insert into exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at, is_active)
       values ($1, $2, now() + make_interval(mins => $3), now() + make_interval(mins => $4), $5) returning *`,
      [date, label, opens, closes, active]);
  }

  async room(code, { active = true } = {}) {
    return this.one(`insert into rooms (room_code, building, floor, is_active) values ($1, 'Main', '1', $2) returning *`, [code, active]);
  }

  async sessionRoom(session, room, max, { active = true } = {}) {
    return this.one(
      `insert into session_rooms (session_id, room_id, max_invigilators, is_active) values ($1, $2, $3, $4) returning *`,
      [session.id, room.id, max, active]);
  }

  /** Create rooms R1..Rn for a session with the given capacities. */
  async rooms(session, caps, prefix = 'R') {
    const out = [];
    for (let i = 0; i < caps.length; i++) {
      const room = await this.room(`${prefix}${i + 1}`);
      out.push(await this.sessionRoom(session, room, caps[i]));
    }
    return out;
  }

  async schedule(employeeId, session, name = null, dept = 'CSE') {
    await this.q(
      `insert into schedule (employee_id, employee_name, department, exam_date, session_label)
       values ($1, $2, $3, $4, $5)`,
      [employeeId.trim().toUpperCase(), name || 'Name ' + employeeId, dept, session.exam_date, session.session_label]);
  }

  async scheduleMany(prefix, n, session) {
    const ids = [];
    for (let i = 1; i <= n; i++) {
      const id = `${prefix}${String(i).padStart(4, '0')}`;
      ids.push(id);
    }
    await this.q(
      `insert into schedule (employee_id, employee_name, department, exam_date, session_label)
       select x, 'Name ' || x, 'CSE', $2::date, $3 from unnest($1::text[]) x`,
      [ids, session.exam_date, session.session_label]);
    return ids;
  }

  // ---- calls -------------------------------------------------------------

  async checkin(client, id) {
    const r = await client.query('select public.checkin($1) as r', [id]);
    return r.rows[0].r;
  }

  /** Active allocation counts per room code for a session. */
  async counts(session) {
    const rows = await this.q(
      `select r.room_code, sr.max_invigilators as max,
              count(a.id) filter (where a.released_at is null)::int as active
         from session_rooms sr join rooms r on r.id = sr.room_id
         left join allocations a on a.session_room_id = sr.id
        where sr.session_id = $1 group by r.room_code, sr.max_invigilators order by r.room_code`,
      [session.id]);
    return Object.fromEntries(rows.map((r) => [r.room_code, r.active]));
  }
}

/**
 * Replays allocations in insertion order (seq) and returns every violation of the policy:
 * the chosen room must be an eligible room (usable, below capacity) holding the MINIMUM
 * active count at that moment. Valid only for runs without releases/corrections.
 */
async function replayViolations(world, session) {
  const rooms = await world.q(
    `select sr.id, sr.max_invigilators as max, (sr.is_active and r.is_active) as usable
       from session_rooms sr join rooms r on r.id = sr.room_id where sr.session_id = $1`, [session.id]);
  const counts = new Map(rooms.map((r) => [r.id, 0]));
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const allocs = await world.q(`select seq, session_room_id from allocations where session_id = $1 order by seq`, [session.id]);
  const violations = [];
  for (const a of allocs) {
    const eligible = rooms.filter((r) => r.usable && counts.get(r.id) < r.max);
    const min = Math.min(...eligible.map((r) => counts.get(r.id)));
    const chosen = byId.get(a.session_room_id);
    if (!chosen.usable || counts.get(chosen.id) >= chosen.max || counts.get(chosen.id) !== min) {
      violations.push({ seq: a.seq, room: chosen.id, count: counts.get(chosen.id), min });
    }
    counts.set(chosen.id, counts.get(chosen.id) + 1);
  }
  return violations;
}

/** Global integrity checks that must hold after ANY run. Returns a list of problems. */
async function integrityProblems(world) {
  const problems = [];
  const over = await world.q(
    `select sr.id, sr.max_invigilators as max, count(a.id)::int as active
       from session_rooms sr join allocations a on a.session_room_id = sr.id and a.released_at is null
      group by sr.id, sr.max_invigilators having count(a.id) > sr.max_invigilators`);
  if (over.length) problems.push({ overCapacity: over });
  const dup = await world.q(
    `select session_id, employee_id, count(*)::int from allocations where released_at is null
      group by 1, 2 having count(*) > 1`);
  if (dup.length) problems.push({ duplicateActive: dup });
  const inactive = await world.q(
    `select a.id from allocations a join session_rooms sr on sr.id = a.session_room_id
       join rooms r on r.id = sr.room_id
      where a.released_at is null and not (sr.is_active and r.is_active)`);
  if (inactive.length) problems.push({ activeInInactiveRoom: inactive });
  return problems;
}

module.exports = { World, buildTemplate, dropTemplate, replayViolations, integrityProblems };

// Load scenarios against the LOCAL stack (browser-shaped HTTP -> stand-in front door -> PostgREST -> PostgreSQL in Docker).
// These numbers describe THIS machine's Docker setup only. They are NOT Supabase measurements.
//   npm run stack:up && node tools/load/http-load.mjs [--out results/http-load.json]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const S = require('../../tests/api/stack.js');
await S.startStack();

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0).toFixed(1); };
const tally = (rs) => rs.reduce((m, r) => ((m[r.body?.code ?? `HTTP_${r.status}`] = (m[r.body?.code ?? `HTTP_${r.status}`] || 0) + 1), m), {});

async function integrity(sessionId) {
  const [{ dup }] = await S.sql(`select count(*)::int dup from (select employee_id from allocations where session_id = $1 and released_at is null group by 1 having count(*) > 1) x`, [sessionId]);
  const [{ over_cap: over }] = await S.sql(`select count(*)::int over_cap from (select sr.id from session_rooms sr join allocations a on a.session_room_id = sr.id and a.released_at is null
                                    where sr.session_id = $1 group by sr.id, sr.max_invigilators having count(*) > sr.max_invigilators) x`, [sessionId]);
  const [{ n }] = await S.sql(`select count(*)::int n from allocations where session_id = $1 and released_at is null`, [sessionId]);
  return { duplicateActive: dup, overCapacity: over, activeAllocations: n };
}

const results = [];
async function scenario(name, { caps, employees, plan, note }) {
  await S.reset();
  const { ids, session } = await S.seedOpenSession({ caps, employees });
  const calls = plan(ids);
  const t0 = Date.now();
  const rs = await calls();
  const wallMs = Date.now() - t0;
  const lat = rs.map((r) => r.ms);
  const out = { name, note, requests: rs.length, wallMs, p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: pct(lat, 100),
    codes: tally(rs), httpErrors: rs.filter((r) => r.status !== 200).length, ...(await integrity(session.id)) };
  results.push(out);
  console.log(`${name.padEnd(46)} n=${out.requests} p50=${out.p50}ms p95=${out.p95}ms p99=${out.p99}ms max=${out.max}ms errors=${out.httpErrors} dup=${out.duplicateActive} over=${out.overCapacity} codes=${JSON.stringify(out.codes)}`);
}

const checkin = (id) => S.rpc('checkin', { p_employee_id: id });

await scenario('A. 100 simultaneous distinct employees', { caps: Array(10).fill(12), employees: 100, plan: (ids) => () => Promise.all(ids.map(checkin)) });
await scenario('B. 200 simultaneous distinct employees', { caps: Array(20).fill(12), employees: 200, plan: (ids) => () => Promise.all(ids.map(checkin)) });
await scenario('C. 200 simultaneous, one employee repeated', { caps: [5, 5], employees: 5, plan: () => () => Promise.all(Array.from({ length: 200 }, () => checkin('E0001'))) });
await scenario('D. 250 simultaneous into 150 slots (exhaustion)', { caps: Array(15).fill(10), employees: 250, plan: (ids) => () => Promise.all(ids.map(checkin)) });
await scenario('E. 500 paced over 60 s (8.3 req/s, distinct)', {
  caps: Array(25).fill(24), employees: 500, note: 'arrival rate sustained for 60 s, not the 15-20 minutes of a real session',
  plan: (ids) => async () => {
    const rs = [];
    const start = Date.now();
    await Promise.all(ids.map(async (id, i) => {
      const wait = start + (i * 60_000) / ids.length - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      rs.push(await checkin(id));
    }));
    return rs;
  },
});

const outFile = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null;
if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), environment: 'local Docker (PostgreSQL 17 + PostgREST 12.2.3); NOT Supabase', results }, null, 2)); }
S.stopStack();
const bad = results.filter((r) => r.duplicateActive || r.overCapacity || r.httpErrors);
if (bad.length) { console.error('FAILED correctness/error criteria:', bad.map((b) => b.name)); process.exit(1); }
process.exit(0);

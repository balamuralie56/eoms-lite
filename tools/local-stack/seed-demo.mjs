// Loads a small DEMO data set into the LOCAL test database so the app can be explored by hand.
// Wipes the local test database first. Requires the local stack server (npm run stack:server) and `npm run stack:up`.
//   node tools/local-stack/seed-demo.mjs
import pg from 'pg';

const API = process.env.STACK_URL || 'http://127.0.0.1:54321';
const DB = process.env.E2E_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:54329/eoms_e2e';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) { console.error('non-local database refused'); process.exit(1); }

const post = (p, b = {}) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const ADMIN = { email: 'admin@example.test', password: 'demo-admin-password' };

await post('/__test/reset');
await post('/__test/admin', ADMIN);
await post('/__test/admin', { email: 'viewer@example.test', password: 'demo-not-admin', admin: false });

const c = new pg.Client({ connectionString: DB });
await c.connect();
const q = (t, p) => c.query(t, p).then((r) => r.rows);
try {
  await q(`update app_branding set institution_name = 'Greenfield University', exam_cell_name = 'Controller of Examinations', app_title = 'Invigilator Check-In',
           contact_instructions = 'Please contact the Examination Cell, Room 12, Admin Block.', support_info = 'Help desk: 0123-456789 (demo)' where id = 1`);

  const today = (await q(`select ((now() at time zone 'Asia/Kolkata')::date)::text d`))[0].d;
  const tomorrow = (await q(`select ((now() at time zone 'Asia/Kolkata')::date + 1)::text d`))[0].d;

  // Today's forenoon session is OPEN right now (window: 2 h ago .. 3 h ahead). Tomorrow's FN/AN are upcoming.
  const [fn] = await q(`insert into exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at)
                        values ($1, 'FN', now() - interval '2 hours', now() + interval '3 hours') returning id`, [today]);
  for (const [label, from, to] of [['FN', '08:00', '10:00'], ['AN', '13:00', '15:00']]) {
    await q(`insert into exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at)
             values ($1::date, $2, ($1::date + $3::time) at time zone 'Asia/Kolkata', ($1::date + $4::time) at time zone 'Asia/Kolkata')`, [tomorrow, label, from, to]);
  }

  const rooms = [['A101', 'Main Block', '1', 3], ['A102', 'Main Block', '1', 2], ['B201', 'Science Block', '2', 4], ['B202', 'Science Block', '2', 2], ['C301', 'Library Wing', '3', 3]];
  for (const [code, building, floor, cap] of rooms) {
    const [r] = await q(`insert into rooms (room_code, building, floor) values ($1, $2, $3) returning id`, [code, building, floor]);
    await q(`insert into session_rooms (session_id, room_id, max_invigilators) values ($1, $2, $3)`, [fn.id, r.id, cap]);
  }

  const depts = ['Physics', 'Chemistry', 'Mathematics', 'Computer Science', 'English', 'Commerce'];
  const first = ['Asha', 'Ben', 'Chitra', 'Dev', 'Esha', 'Farid', 'Gita', 'Hari', 'Isha', 'Jay', 'Kavya', 'Lakshmi', 'Manoj', 'Nisha', 'Omar', 'Priya', 'Qasim', 'Ravi', 'Sana', 'Tarun'];
  const last = ['Rao', 'Joy', 'Nair', 'Kumar', 'Patel', 'Khan', 'Iyer', 'Shah', 'Das', 'Menon'];
  for (let i = 0; i < 40; i++) {
    const id = `EMP${String(i + 1).padStart(3, '0')}`;
    await q(`insert into schedule (employee_id, employee_name, department, exam_date, session_label) values ($1, $2, $3, $4, 'FN')`,
      [id, `${first[i % first.length]} ${last[(i * 3) % last.length]}`, depts[i % depts.length], today]);
  }

  // some employees have already checked in; one is flagged for verification; one was released
  for (let i = 1; i <= 8; i++) await q(`select public.checkin($1)`, [`EMP${String(i).padStart(3, '0')}`]);
  await q(`insert into employee_flags (session_id, employee_id, reason, created_by)
           select $1, 'EMP012', 'Photo on ID does not match (demo flag)', user_id from admins where email = $2`, [fn.id, ADMIN.email]);
  const [a8] = await q(`select id from allocations where employee_id = 'EMP008'`);
  await q(`update allocations set released_at = now(), released_by = (select user_id from admins where email = $2), release_reason = 'Fell ill (demo)' where id = $1`, [a8.id, ADMIN.email]);
  console.log(`demo data ready: session ${today} FN is OPEN now; 40 scheduled, 8 checked in (1 released), 1 flagged, 5 rooms`);
  console.log(`admin login: ${ADMIN.email} / ${ADMIN.password}   (viewer@example.test / demo-not-admin is signed-in but NOT an admin)`);
} finally { await c.end(); }

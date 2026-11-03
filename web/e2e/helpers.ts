import { Client } from 'pg';
import type { Page } from '@playwright/test';

export const API = 'http://127.0.0.1:54321';
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:54329/eoms_e2e';

export async function sql<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try { return (await c.query(text, params)).rows as T[]; } finally { await c.end(); }
}

async function post(path: string, body: unknown = {}) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
export const resetDb = () => post('/__test/reset');
export const setTokenTtl = (seconds: number) => post('/__test/ttl', { seconds });

export const ADMIN = { email: 'admin@example.test', password: 'correct horse battery' };
export async function createAdmin(over: Partial<{ email: string; password: string; admin: boolean; active: boolean }> = {}) {
  const a = { ...ADMIN, ...over };
  await post('/__test/admin', a);
  return a;
}

export async function istDate(offsetDays = 0): Promise<string> {
  return (await sql<{ d: string }>(`select ((now() at time zone 'Asia/Kolkata')::date + $1::int)::text d`, [offsetDays]))[0].d;
}

export interface Seeded { sessionId: string; examDate: string; ids: string[]; roomIds: string[]; srIds: string[] }

/** One session (default: open now), rooms R1..Rn with capacities, and scheduled employees PREFIX0001... */
export async function seed(o: { label?: 'FN' | 'AN'; opens?: number; closes?: number; active?: boolean; caps?: number[]; employees?: number; prefix?: string; names?: (i: number) => string } = {}): Promise<Seeded> {
  const { label = 'FN', opens = -30, closes = 30, active = true, caps = [3, 3], employees = 6, prefix = 'E' } = o;
  const examDate = await istDate(0);
  const [s] = await sql<{ id: string }>(
    `insert into exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at, is_active)
     values ($1, $2, now() + make_interval(mins => $3), now() + make_interval(mins => $4), $5) returning id`, [examDate, label, opens, closes, active]);
  const roomIds: string[] = [];
  const srIds: string[] = [];
  for (let i = 0; i < caps.length; i++) {
    const [r] = await sql<{ id: string }>(`insert into rooms (room_code, building, floor) values ($1, 'Main Block', $2) returning id`, [`R${i + 1}`, String(i + 1)]);
    const [sr] = await sql<{ id: string }>(`insert into session_rooms (session_id, room_id, max_invigilators) values ($1, $2, $3) returning id`, [s.id, r.id, caps[i]]);
    roomIds.push(r.id); srIds.push(sr.id);
  }
  const ids = Array.from({ length: employees }, (_, i) => `${prefix}${String(i + 1).padStart(4, '0')}`);
  for (let i = 0; i < ids.length; i++) {
    await sql(`insert into schedule (employee_id, employee_name, department, exam_date, session_label) values ($1, $2, $3, $4, $5)`,
      [ids[i], o.names ? o.names(i) : `Employee ${ids[i]}`, `Dept ${(i % 3) + 1}`, examDate, label]);
  }
  return { sessionId: s.id, examDate, ids, roomIds, srIds };
}

export async function loginAs(page: Page, email = ADMIN.email, password = ADMIN.password) {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function checkInAs(page: Page, id: string) {
  await page.goto('/');
  await page.getByTestId('employee-id').fill(id);
  await page.getByTestId('submit-checkin').click();
}

/** Reads width/height from a PNG's IHDR chunk. */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Employee check-in performed directly in SQL (same function the public page calls). */
export async function checkinSql(id: string) {
  return (await sql<{ r: { code: string; room_code?: string } }>(`select public.checkin($1) as r`, [id]))[0].r;
}

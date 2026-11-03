const IST = 'Asia/Kolkata';

// Built from formatToParts so the output is identical across browsers/ICU versions (punctuation differs between engines).
const dt = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const tm = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true });
const dayOnly = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

type Parts = Record<string, string>;
const parts = (f: Intl.DateTimeFormat, d: Date): Parts =>
  Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
const clock = (p: Parts) => `${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toLowerCase()}`.trim();

/** "3 Nov 2026, 8:30 am" in Asia/Kolkata. */
export function formatIst(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p = parts(dt, d);
  return `${p.day} ${p.month} ${p.year}, ${clock(p)}`;
}

export function formatIstTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : clock(parts(tm, d));
}

/** 'YYYY-MM-DD' (a calendar date, no zone) -> "Tue, 3 Nov 2026". */
export function formatExamDate(ymd: string | null | undefined): string {
  if (!ymd) return '-';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const p = parts(dayOnly, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}`;
}

export function sessionName(label: string | null | undefined): string {
  return label === 'FN' ? 'Forenoon (FN)' : label === 'AN' ? 'Afternoon (AN)' : '-';
}

/** <input type="datetime-local"> value -> the IST wall-clock text the API expects ("2026-11-03 08:30"). */
export function localInputToApi(v: string): string {
  return v.replace('T', ' ');
}

/** "2026-11-03 08:30" (IST text from the API) -> datetime-local value. */
export function apiToLocalInput(v: string): string {
  return v.replace(' ', 'T');
}

/** Today (or +offset days) as YYYY-MM-DD in Asia/Kolkata. */
export function istDateString(offsetDays = 0, now = new Date()): string {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** 20261103-0830 (IST) for file names. */
export function istTimestampFilename(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('year')}${g('month')}${g('day')}-${g('hour')}${g('minute')}`;
}

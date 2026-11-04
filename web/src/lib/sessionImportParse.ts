/**
 * Session import parsing (Examination Date, Session, Check-in Opens, Check-in Closes, Active). Opens/Closes
 * are HH:MM (24-hour, Asia/Kolkata) applied to that row's exam date — bulk import does not support a window
 * that crosses midnight; use the single "New session" form for that case.
 */
import readXlsxFile from 'read-excel-file/browser';
import Papa from 'papaparse';
import { checkFile, dateToIso, excelSerialToIso } from './importParse';

export const MAX_ROWS = 500;
export const REQUIRED_COLUMNS = ['Examination Date', 'Session', 'Check-in Opens', 'Check-in Closes'] as const;

type Key = 'exam_date' | 'session_label' | 'opens' | 'closes' | 'active';

const HEADER_TO_KEY: Record<string, Key> = {
  examinationdate: 'exam_date', examdate: 'exam_date', date: 'exam_date',
  session: 'session_label', sessionlabel: 'session_label',
  checkinopens: 'opens', opens: 'opens', checkinopensist: 'opens', openingtime: 'opens',
  checkincloses: 'closes', closes: 'closes', checkinclosesist: 'closes', closingtime: 'closes',
  active: 'active', isactive: 'active',
};

export interface ParsedSessionRow { row: number; exam_date: string; session_label: string; opens: string; closes: string; active: string }

export interface SessionParseResult {
  rows: ParsedSessionRow[];
  headerErrors: string[];
  ignoredColumns: string[];
  blankRowsSkipped: number;
}

const normHeader = (h: unknown) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cellToDateString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : dateToIso(v);
  if (typeof v === 'number' && Number.isFinite(v) && v >= 20_000 && v <= 80_000) return excelSerialToIso(v);
  return String(v).trim();
}

/** Excel stores a time-only cell as a Date on 1899-12-30, or as a fractional-day number. */
function cellToTimeString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return `${String(v.getUTCHours()).padStart(2, '0')}:${String(v.getUTCMinutes()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1) {
    const totalMinutes = Math.round(v * 24 * 60);
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
  }
  return String(v).trim();
}

export function normalizeSessionsTable(table: unknown[][]): SessionParseResult {
  const result: SessionParseResult = { rows: [], headerErrors: [], ignoredColumns: [], blankRowsSkipped: 0 };
  const isBlank = (r: unknown[]) => r.every((c) => c === null || c === undefined || String(c).trim() === '');
  const headerIdx = table.findIndex((r) => !isBlank(r));
  if (headerIdx < 0) { result.headerErrors.push('The file is empty.'); return result; }
  const header = table[headerIdx];
  const colFor = new Map<Key, number>();
  header.forEach((h, i) => {
    const key = HEADER_TO_KEY[normHeader(h)];
    if (key && !colFor.has(key)) colFor.set(key, i);
    else if (String(h ?? '').trim() !== '') result.ignoredColumns.push(String(h).trim());
  });
  const missing: string[] = [];
  if (!colFor.has('exam_date')) missing.push('Examination Date');
  if (!colFor.has('session_label')) missing.push('Session');
  if (!colFor.has('opens')) missing.push('Check-in Opens');
  if (!colFor.has('closes')) missing.push('Check-in Closes');
  if (missing.length) {
    result.headerErrors.push(
      `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Expected columns: ${REQUIRED_COLUMNS.join(', ')} (Active is optional).`,
    );
    return result;
  }
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    if (isBlank(r)) { result.blankRowsSkipped += 1; continue; }
    const cell = (k: Key) => (colFor.has(k) ? r[colFor.get(k)!] : undefined);
    result.rows.push({
      row: i + 1,
      exam_date: cellToDateString(cell('exam_date')),
      session_label: String(cell('session_label') ?? '').trim(),
      opens: cellToTimeString(cell('opens')),
      closes: cellToTimeString(cell('closes')),
      active: String(cell('active') ?? '').trim(),
    });
  }
  if (result.rows.length === 0) result.headerErrors.push('The file has a header but no data rows.');
  return result;
}

export async function parseSessionsFile(file: File): Promise<SessionParseResult> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const kind = checkFile(file, head);
  if ('error' in kind) throw new Error(kind.error);
  if (kind.kind === 'csv') {
    const raw = await file.text();
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
    return normalizeSessionsTable(parsed.data as unknown[][]);
  }
  const sheet = await readXlsxFile(file);
  return normalizeSessionsTable(sheet as unknown as unknown[][]);
}

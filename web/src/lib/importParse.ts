/**
 * Schedule import parsing. Pure functions (no DOM, no workers) so they are unit-testable. The browser parses; the
 * database re-validates everything. Only the five required columns are read: nothing else about an employee is sent.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5000;

export const REQUIRED_COLUMNS = ['Employee ID', 'Name', 'Department', 'Examination Date', 'Session'] as const;

type Key = 'employee_id' | 'name' | 'department' | 'date' | 'session';

const HEADER_TO_KEY: Record<string, Key> = {
  employeeid: 'employee_id',
  name: 'name',
  department: 'department',
  examinationdate: 'date',
  examdate: 'date',
  session: 'session',
};

export interface ParsedRow {
  /** spreadsheet row number (the header is row 1) */
  row: number;
  employee_id: string;
  name: string;
  department: string;
  date: string;
  session: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  headerErrors: string[];
  ignoredColumns: string[];
  blankRowsSkipped: number;
}

const normHeader = (h: unknown) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Date -> YYYY-MM-DD using UTC parts (spreadsheet dates are calendar dates; local time zones must not shift them). */
export function dateToIso(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Excel 1900-date-system serial (days since 1899-12-30) -> YYYY-MM-DD. */
export function excelSerialToIso(serial: number): string {
  return dateToIso(new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000));
}

function cellToString(v: unknown, isDate: boolean): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : dateToIso(v);
  if (typeof v === 'number') {
    // a plain number in the date column is an unformatted Excel serial; anything else is kept as typed
    if (isDate && Number.isFinite(v) && v >= 20_000 && v <= 80_000) return excelSerialToIso(v);
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return String(v).trim();
}

export function normalizeTable(table: unknown[][]): ParseResult {
  const result: ParseResult = { rows: [], headerErrors: [], ignoredColumns: [], blankRowsSkipped: 0 };
  const isBlank = (r: unknown[]) => r.every((c) => c === null || c === undefined || String(c).trim() === '');
  const headerIdx = table.findIndex((r) => !isBlank(r));
  if (headerIdx < 0) {
    result.headerErrors.push('The file is empty.');
    return result;
  }
  const header = table[headerIdx];
  const colFor = new Map<Key, number>();
  header.forEach((h, i) => {
    const key = HEADER_TO_KEY[normHeader(h)];
    if (key && !colFor.has(key)) colFor.set(key, i);
    else if (String(h ?? '').trim() !== '') result.ignoredColumns.push(String(h).trim());
  });
  const missing: string[] = [];
  if (!colFor.has('employee_id')) missing.push('Employee ID');
  if (!colFor.has('name')) missing.push('Name');
  if (!colFor.has('department')) missing.push('Department');
  if (!colFor.has('date')) missing.push('Examination Date');
  if (!colFor.has('session')) missing.push('Session');
  if (missing.length) {
    result.headerErrors.push(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Expected columns: ${REQUIRED_COLUMNS.join(', ')}.`);
    return result;
  }
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    if (isBlank(r)) { result.blankRowsSkipped += 1; continue; }
    const get = (k: Key) => cellToString(r[colFor.get(k)!], k === 'date');
    result.rows.push({
      row: i + 1,
      employee_id: get('employee_id'), name: get('name'), department: get('department'),
      date: get('date'), session: get('session'),
    });
  }
  if (result.rows.length === 0) result.headerErrors.push('The file has a header but no data rows.');
  return result;
}

export type FileKind = { kind: 'csv' | 'xlsx' } | { error: string };

/** Cheap, content-aware file checks done before any parsing. `head` = first bytes of the file. */
export function checkFile(file: { name: string; size: number }, head?: Uint8Array): FileKind {
  const name = file.name.toLowerCase();
  if (file.size === 0) return { error: 'The file is empty.' };
  if (file.size > MAX_FILE_BYTES) return { error: `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.` };
  if (name.endsWith('.xlsx')) {
    if (head && !(head[0] === 0x50 && head[1] === 0x4b)) return { error: 'This does not look like a real .xlsx file (it is not a valid Excel archive).' };
    return { kind: 'xlsx' };
  }
  if (name.endsWith('.csv')) {
    if (head && head.slice(0, 4096).includes(0)) return { error: 'This does not look like a text CSV file.' };
    return { kind: 'csv' };
  }
  if (name.endsWith('.xls')) return { error: 'Old .xls files are not supported. Save the sheet as .xlsx or .csv.' };
  return { error: 'Please choose a .csv or .xlsx file.' };
}

/**
 * Room import parsing (Room Code, Building, Floor, Capacity). Room lists are small (hundreds, not thousands),
 * so unlike the schedule import this parses on the main thread — no web worker needed.
 */
import readXlsxFile from 'read-excel-file/browser';
import Papa from 'papaparse';
import { checkFile } from './importParse';

export const MAX_ROWS = 1000;
export const REQUIRED_COLUMNS = ['Room Code', 'Capacity'] as const;

type Key = 'room_code' | 'building' | 'floor' | 'capacity';

const HEADER_TO_KEY: Record<string, Key> = {
  roomcode: 'room_code', room: 'room_code', code: 'room_code', roomno: 'room_code', roomnumber: 'room_code',
  building: 'building', block: 'building',
  floor: 'floor',
  capacity: 'capacity', maxinvigilators: 'capacity', invigilatorcapacity: 'capacity', invigilators: 'capacity',
};

export interface ParsedRoomRow { row: number; room_code: string; building: string; floor: string; capacity: string }

export interface RoomParseResult {
  rows: ParsedRoomRow[];
  headerErrors: string[];
  ignoredColumns: string[];
  blankRowsSkipped: number;
}

const normHeader = (h: unknown) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

export function normalizeRoomsTable(table: unknown[][]): RoomParseResult {
  const result: RoomParseResult = { rows: [], headerErrors: [], ignoredColumns: [], blankRowsSkipped: 0 };
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
  if (!colFor.has('room_code')) missing.push('Room Code');
  if (!colFor.has('capacity')) missing.push('Capacity');
  if (missing.length) {
    result.headerErrors.push(
      `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Expected columns: Room Code, Building, Floor, Capacity (Building and Floor are optional).`,
    );
    return result;
  }
  for (let i = headerIdx + 1; i < table.length; i++) {
    const r = table[i];
    if (isBlank(r)) { result.blankRowsSkipped += 1; continue; }
    const get = (k: Key) => (colFor.has(k) ? cellToString(r[colFor.get(k)!]) : '');
    result.rows.push({ row: i + 1, room_code: get('room_code'), building: get('building'), floor: get('floor'), capacity: get('capacity') });
  }
  if (result.rows.length === 0) result.headerErrors.push('The file has a header but no data rows.');
  return result;
}

export async function parseRoomsFile(file: File): Promise<RoomParseResult> {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const kind = checkFile(file, head);
  if ('error' in kind) throw new Error(kind.error);
  if (kind.kind === 'csv') {
    const raw = await file.text();
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false });
    return normalizeRoomsTable(parsed.data as unknown[][]);
  }
  const sheet = await readXlsxFile(file);
  return normalizeRoomsTable(sheet as unknown as unknown[][]);
}

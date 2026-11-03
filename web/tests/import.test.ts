// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import Papa from 'papaparse';
import writeXlsx from 'write-excel-file/node';
import { readSheet } from 'read-excel-file/node';
import { checkFile, dateToIso, excelSerialToIso, normalizeTable } from '../src/lib/importParse';
import { UploadError, uploadRows } from '../src/lib/importUpload';
import { ApiError } from '../src/lib/rpc';

const HEADER = ['Employee ID', 'Name', 'Department', 'Examination Date', 'Session'];

describe('normalizeTable', () => {
  it('maps the five required columns case/space/punctuation-insensitively and reports spreadsheet row numbers', () => {
    const r = normalizeTable([
      ['employee id', ' NAME ', 'Department', 'Examination_Date', 'SESSION'],
      ['E1', 'Asha', 'Physics', '2026-11-03', 'FN'],
      ['E2', 'Ben', 'Maths', '03/11/2026', 'Afternoon'],
    ]);
    expect(r.headerErrors).toEqual([]);
    expect(r.rows.map((x) => [x.row, x.employee_id, x.name, x.session])).toEqual([[2, 'E1', 'Asha', 'FN'], [3, 'E2', 'Ben', 'Afternoon']]);
  });

  it('ignores extra columns (nothing unnecessary about an employee is sent) and says which', () => {
    const r = normalizeTable([[...HEADER, 'Mobile', 'Email'], ['E1', 'A', 'D', '2026-11-03', 'FN', '9999999999', 'a@b.c']]);
    expect(r.ignoredColumns).toEqual(['Mobile', 'Email']);
    expect(Object.keys(r.rows[0]).sort()).toEqual(['date', 'department', 'employee_id', 'name', 'row', 'session']);
  });

  it('rejects a wrong spreadsheet by naming the missing columns', () => {
    const r = normalizeTable([['Room', 'Capacity'], ['A1', 30]]);
    expect(r.rows).toEqual([]);
    expect(r.headerErrors[0]).toMatch(/Missing columns: Employee ID, Name, Department, Examination Date, Session/);
  });

  it('skips blank rows but keeps the original row numbers; leading blank rows before the header are tolerated', () => {
    const r = normalizeTable([[null, ''], HEADER, ['E1', 'A', 'D', '2026-11-03', 'FN'], [null, null, null, null, null], ['E2', 'B', 'D', '2026-11-03', 'AN']]);
    expect(r.rows.map((x) => x.row)).toEqual([3, 5]);
    expect(r.blankRowsSkipped).toBe(1);
  });

  it('reports empty files and header-only files', () => {
    expect(normalizeTable([]).headerErrors[0]).toMatch(/empty/i);
    expect(normalizeTable([HEADER]).headerErrors[0]).toMatch(/no data rows/i);
  });

  it('converts Excel Date cells to ISO using UTC parts (no time-zone shift) and numeric serials in the date column', () => {
    const r = normalizeTable([HEADER, ['E1', 'A', 'D', new Date('2026-11-03T00:00:00.000Z'), 'FN'], [1002, 'B', 'D', 46329, 'AN'], ['E3', 'C', 'D', new Date('2026-11-03T23:30:00.000Z'), 'FN']]);
    expect(r.rows[0].date).toBe('2026-11-03');
    expect(r.rows[1].date).toBe('2026-11-03');
    expect(r.rows[1].employee_id).toBe('1002');
    expect(r.rows[2].date).toBe('2026-11-03');
  });

  it('does not turn a numeric Employee ID or name into a date', () => {
    const r = normalizeTable([HEADER, [46329, 12345, 'D', '2026-11-03', 'FN']]);
    expect(r.rows[0].employee_id).toBe('46329');
    expect(r.rows[0].name).toBe('12345');
  });

  it('dateToIso / excelSerialToIso', () => {
    expect(dateToIso(new Date('2030-01-09T00:00:00Z'))).toBe('2030-01-09');
    expect(excelSerialToIso(45292)).toBe('2024-01-01');
  });
});

describe('real CSV and XLSX files', () => {
  it('parses a CSV with quoted fields, BOM-less UTF-8 names and CRLF line endings', () => {
    const csv = 'Employee ID,Name,Department,Examination Date,Session\r\nE1,"Rao, Asha",Physics,2026-11-03,FN\r\nE2,Zoë Müller,Maths,03-11-2026,AN\r\n';
    const t = Papa.parse<string[]>(csv, { skipEmptyLines: false }).data as unknown[][];
    const r = normalizeTable(t);
    expect(r.headerErrors).toEqual([]);
    expect(r.rows.map((x) => x.name)).toEqual(['Rao, Asha', 'Zoë Müller']);
    expect(r.rows).toHaveLength(2);
  });

  it('round-trips a real .xlsx written with a date cell, a numeric ID and a text session', async () => {
    const file = Buffer.from(await (await writeXlsx([
      HEADER.map((h) => ({ value: h, fontWeight: 'bold' as const })),
      [{ value: 1001, type: Number }, { value: 'Asha Rao', type: String }, { value: 'Physics', type: String }, { value: new Date('2026-11-03T00:00:00Z'), type: Date, format: 'yyyy-mm-dd' }, { value: 'FN', type: String }],
      [{ value: 'E2', type: String }, { value: 'Ben', type: String }, { value: 'Maths', type: String }, { value: '03/11/2026', type: String }, { value: 'Afternoon', type: String }],
    ] as never).toBuffer()));
    const sheet = await readSheet(file);
    const r = normalizeTable(sheet as unknown[][]);
    expect(r.headerErrors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ row: 2, employee_id: '1001', name: 'Asha Rao', date: '2026-11-03', session: 'FN' });
    expect(r.rows[1]).toMatchObject({ row: 3, employee_id: 'E2', date: '03/11/2026', session: 'Afternoon' });
  });
});

describe('checkFile', () => {
  const pk = new Uint8Array([0x50, 0x4b, 3, 4]);
  it('accepts csv and xlsx, rejects other types, .xls, empty and oversized files', () => {
    expect(checkFile({ name: 'a.CSV', size: 10 })).toEqual({ kind: 'csv' });
    expect(checkFile({ name: 'a.xlsx', size: 10 }, pk)).toEqual({ kind: 'xlsx' });
    expect(checkFile({ name: 'a.xls', size: 10 })).toHaveProperty('error');
    expect(checkFile({ name: 'a.pdf', size: 10 })).toHaveProperty('error');
    expect(checkFile({ name: 'a.csv', size: 0 })).toHaveProperty('error');
    expect(checkFile({ name: 'a.csv', size: 6 * 1024 * 1024 })).toHaveProperty('error');
  });
  it('looks inside the file: an .xlsx that is not a zip, or a binary file named .csv, is refused', () => {
    expect(checkFile({ name: 'fake.xlsx', size: 100 }, new Uint8Array([0x4d, 0x5a, 0, 0]))).toHaveProperty('error');
    expect(checkFile({ name: 'fake.csv', size: 100 }, new Uint8Array([65, 66, 0, 67]))).toHaveProperty('error');
    expect(checkFile({ name: 'ok.csv', size: 100 }, new TextEncoder().encode('a,b\n1,2'))).toEqual({ kind: 'csv' });
  });
});

describe('uploadRows (chunking, retry, resume, no duplicates)', () => {
  const rows = Array.from({ length: 1234 }, (_, i) => ({ row: i + 2, employee_id: `E${i}`, name: 'N', department: 'D', date: '2026-11-03', session: 'FN' }));
  const sleep = () => Promise.resolve();

  it('sends chunks of at most 500 rows, in order, and reports progress', async () => {
    const sent: number[] = [];
    const progress: number[] = [];
    await uploadRows('b1', rows, { chunkSize: 9999, onProgress: (d) => progress.push(d) }, { addRows: async (_b, chunk) => { sent.push(chunk.length); }, sleep });
    expect(sent).toEqual([500, 500, 234]);
    expect(progress).toEqual([500, 1000, 1234]);
  });

  it('sends only the five import fields', async () => {
    let first: Record<string, unknown> | undefined;
    await uploadRows('b1', rows.slice(0, 1), { chunkSize: 500 }, { addRows: async (_b, c) => { first = c[0] as Record<string, unknown>; }, sleep });
    expect(Object.keys(first!).sort()).toEqual(['date', 'department', 'employee_id', 'name', 'row', 'session']);
  });

  it('retries a failed chunk with backoff; a lost response cannot create duplicates because row numbers are the identity', async () => {
    const received = new Map<number, number>();            // row number -> times received (the server upserts by row number)
    let calls = 0;
    const addRows = async (_b: string, chunk: unknown[]) => {
      calls += 1;
      for (const c of chunk as Array<{ row: number }>) received.set(c.row, (received.get(c.row) ?? 0) + 1);
      if (calls === 1) throw new ApiError('Failed to fetch', '', 0);     // the server got it, the response was lost
    };
    const delays: number[] = [];
    await uploadRows('b1', rows, { chunkSize: 500 }, { addRows, sleep: async (ms) => { delays.push(ms); }, random: () => 1 });
    expect(delays).toEqual([500]);
    expect(received.size).toBe(rows.length);                // every row present exactly once as a key...
    expect(received.get(2)).toBe(2);                        // ...the retried ones were simply sent twice (idempotent upsert server side)
  });

  it('gives up after the attempt limit with the index to resume from, and resuming continues without re-sending earlier chunks', async () => {
    let fail = true;
    const log: number[] = [];
    const addRows = async (_b: string, chunk: unknown[]) => {
      const first = (chunk[0] as { row: number }).row;
      if (first === 502 && fail) throw new ApiError('Failed to fetch', '', 0);
      log.push(first);
    };
    await expect(uploadRows('b1', rows, { chunkSize: 500, attempts: 3 }, { addRows, sleep })).rejects.toMatchObject({ name: 'UploadError', nextIndex: 500 });
    expect(log).toEqual([2]);
    fail = false;
    await uploadRows('b1', rows, { chunkSize: 500 }, { addRows, sleep }, 500);
    expect(log).toEqual([2, 502, 1002]);
  });

  it('does not retry a validation (4xx) rejection', async () => {
    const addRows = vi.fn().mockRejectedValue(new ApiError('too many rows', '22023', 400));
    await expect(uploadRows('b1', rows, { chunkSize: 500 }, { addRows, sleep })).rejects.toBeInstanceOf(UploadError);
    expect(addRows).toHaveBeenCalledTimes(1);
  });
});

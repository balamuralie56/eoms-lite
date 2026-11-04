// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeSessionsTable } from '../src/lib/sessionImportParse';

const HEADER = ['Examination Date', 'Session', 'Check-in Opens', 'Check-in Closes', 'Active'];

describe('normalizeSessionsTable', () => {
  it('maps the required columns case/space/punctuation-insensitively and reports spreadsheet row numbers', () => {
    const r = normalizeSessionsTable([
      ['examination date', ' SESSION ', 'Check-in Opens', 'CHECK-IN CLOSES', 'Active'],
      ['2026-11-05', 'FN', '07:30', '10:00', 'TRUE'],
      ['2026-11-05', 'AN', '13:00', '16:00', ''],
    ]);
    expect(r.headerErrors).toEqual([]);
    expect(r.rows.map((x) => [x.row, x.exam_date, x.session_label, x.opens, x.closes, x.active])).toEqual([
      [2, '2026-11-05', 'FN', '07:30', '10:00', 'TRUE'],
      [3, '2026-11-05', 'AN', '13:00', '16:00', ''],
    ]);
  });

  it('Active is optional', () => {
    const r = normalizeSessionsTable([HEADER.slice(0, 4), ['2026-11-05', 'FN', '07:30', '10:00']]);
    expect(r.headerErrors).toEqual([]);
    expect(r.rows[0].active).toBe('');
  });

  it('rejects a wrong spreadsheet by naming the missing columns', () => {
    const r = normalizeSessionsTable([['Room Code', 'Capacity'], ['A1', '3']]);
    expect(r.rows).toEqual([]);
    expect(r.headerErrors[0]).toMatch(/Missing columns: Examination Date, Session, Check-in Opens, Check-in Closes/);
  });

  it('ignores extra columns and says which', () => {
    const r = normalizeSessionsTable([[...HEADER, 'Notes'], ['2026-11-05', 'FN', '07:30', '10:00', 'TRUE', 'spare']]);
    expect(r.ignoredColumns).toEqual(['Notes']);
  });

  it('skips blank rows but keeps the original row numbers', () => {
    const r = normalizeSessionsTable([
      HEADER, ['2026-11-05', 'FN', '07:30', '10:00', ''], [null, null, null, null, null], ['2026-11-06', 'AN', '13:00', '16:00', ''],
    ]);
    expect(r.rows.map((x) => x.row)).toEqual([2, 4]);
    expect(r.blankRowsSkipped).toBe(1);
  });

  it('reports an empty file and a header-only file distinctly', () => {
    expect(normalizeSessionsTable([]).headerErrors).toEqual(['The file is empty.']);
    expect(normalizeSessionsTable([HEADER]).headerErrors).toEqual(['The file has a header but no data rows.']);
  });
});

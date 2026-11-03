import { describe, expect, it } from 'vitest';
import { neutralizeCell, safeName, toCsv } from '../src/lib/csv';
import { exportFilename, tableToCsv } from '../src/lib/export';

describe('neutralizeCell (spreadsheet formula injection)', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '  =HYPERLINK("http://evil")', '\t=1', '\r=1', '=cmd|\' /C calc\'!A0'])(
    'prefixes %j so it stays text', (v) => {
      const out = neutralizeCell(v) as string;
      expect(out.startsWith("'")).toBe(true);
      expect(out.slice(1)).toBe(v);
    });
  it.each(['Asha Rao', 'A-101', 'x=y', 'a+b', 'name@example.org', '', '12'])('leaves ordinary text %j alone', (v) => {
    expect(neutralizeCell(v)).toBe(v);
  });
  it('keeps real numbers and booleans typed, and turns null into an empty cell', () => {
    expect(neutralizeCell(-5)).toBe(-5);
    expect(neutralizeCell(true)).toBe(true);
    expect(neutralizeCell(null)).toBe('');
    expect(neutralizeCell(undefined)).toBe('');
  });
  it('serialises objects as JSON, which starts with { or [ and is therefore not a formula', () => {
    expect(neutralizeCell({ a: 1 })).toBe('{"a":1}');
  });
});

describe('toCsv', () => {
  it('quotes commas, quotes and newlines (RFC 4180), adds a BOM, and neutralises formulas', () => {
    const csv = toCsv(['Name', 'Note'], [['Rao, Asha', 'said "hi"'], ['=1+1', 'line1\nline2'], [7, null]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('Name,Note');
    expect(lines[1]).toBe('"Rao, Asha","said ""hi"""');
    expect(lines[2]).toBe("'=1+1,\"line1\nline2\"");
    expect(lines[3]).toBe('7,');
  });
  it('neutralises the header cells too', () => {
    expect(toCsv(['=evil'], []).slice(1)).toBe("'=evil\r\n");
  });
});

describe('export helpers', () => {
  it('builds meaningful file names including session information', () => {
    expect(exportFilename('eoms_session_allocations', ['2026-11-03', 'FN'], 'csv', '20261103-0830')).toBe('eoms_session_allocations_2026-11-03_FN_20261103-0830.csv');
    expect(exportFilename('eoms report', ['a b/c', null, ''], 'xlsx', 'S')).toBe('eoms_report_a_b_c_S.xlsx');
  });
  it('safeName never produces path separators or empty names', () => {
    expect(safeName('../../etc/passwd')).not.toMatch(/[\\/]/);
    expect(safeName('***')).toBe('file');
  });
  it('tableToCsv uses the requested column order and neutralised values', async () => {
    const blob = tableToCsv({ columns: ['employee_name', 'room_code', 'allocated_at_ist'], rows: [{ room_code: 'A1', employee_name: '=CMD()', allocated_at_ist: '2026-11-03 08:00:00' }] });
    const text = await blob.text();                          // Blob.text() strips the BOM, so check the raw bytes separately
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text.split('\r\n')[0]).toBe('Employee name,Room code,Allocated at (IST)');
    expect(text).toContain("'=CMD(),A1,2026-11-03 08:00:00");
    expect(blob.type).toContain('text/csv');
  });
});

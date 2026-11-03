import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fitFontSize, slipFilename, wrapLines } from '../src/lib/slip';
import { apiToLocalInput, formatExamDate, formatIst, formatIstTime, istDateString, istTimestampFilename, localInputToApi, sessionName } from '../src/lib/time';

// A fake monospace measuring function: every character is 10 px wide.
const m = (s: string) => s.length * 10;

describe('slip text layout', () => {
  it('wraps on word boundaries and never exceeds the width', () => {
    const text = 'Professor Alexandria Montgomery of Applied Physics';
    const lines = wrapLines(m, text, 200, 5);
    expect(lines).toEqual(['Professor Alexandria', 'Montgomery of', 'Applied Physics']);
    expect(lines.every((l) => m(l) <= 200)).toBe(true);
    expect(lines.join(' ')).toBe(text);
  });
  it('limits the number of lines and ends the last one with an ellipsis, still within the width', () => {
    const lines = wrapLines(m, 'one two three four five six seven eight nine ten eleven twelve', 100, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(lines.every((l) => m(l) <= 100)).toBe(true);
  });
  it('hard-splits a single token longer than the line (no overflow, nothing lost)', () => {
    const lines = wrapLines(m, 'A'.repeat(45), 100, 10);
    expect(lines.every((l) => m(l) <= 100)).toBe(true);
    expect(lines.join('')).toBe('A'.repeat(45));
  });
  it('handles empty and whitespace-only input', () => {
    expect(wrapLines(m, '   ', 100, 2)).toEqual([]);
    expect(wrapLines(m, 'short', 100, 2)).toEqual(['short']);
  });
  it('shrinks a font until the text fits, but not below the minimum', () => {
    const at = (size: number, text: string) => text.length * size * 0.6;
    expect(fitFontSize(at, 'A101', 700, 260, 70)).toBe(260);                     // already fits: unchanged
    const fitted = fitFontSize(at, 'BLOCK-B-LAB-12', 620, 260, 70);
    expect(at(fitted, 'BLOCK-B-LAB-12')).toBeLessThanOrEqual(620);
    expect(fitFontSize(at, 'X'.repeat(200), 620, 260, 70)).toBe(70);
  });
  it('builds a safe, descriptive file name', () => {
    expect(slipFilename({ employee_id: 'EMP/001', exam_date: '2026-11-03', session: 'FN' })).toBe('allocation-slip_EMP_001_2026-11-03_FN.png');
    expect(slipFilename({ employee_id: '../x', exam_date: '2026-11-03', session: 'AN' })).not.toMatch(/[\\/]\.\./);
  });
});

describe('IST time helpers', () => {
  it('formats instants in Asia/Kolkata regardless of the browser zone', () => {
    expect(formatIst('2026-11-03T03:00:00Z')).toBe('3 Nov 2026, 8:30 am');
    expect(formatIstTime('2026-11-03T09:30:00Z')).toBe('3:00 pm');
    expect(formatIst(null)).toBe('-');
    expect(formatIst('garbage')).toBe('-');
  });
  it('formats calendar dates without any time-zone shift', () => {
    expect(formatExamDate('2026-11-03')).toBe('Tue, 3 Nov 2026');
    expect(formatExamDate('2026-01-01')).toBe('Thu, 1 Jan 2026');
    expect(sessionName('FN')).toBe('Forenoon (FN)');
    expect(sessionName('AN')).toBe('Afternoon (AN)');
  });
  it('converts datetime-local values to and from the API text without touching the clock', () => {
    expect(localInputToApi('2026-11-03T08:30')).toBe('2026-11-03 08:30');
    expect(apiToLocalInput('2026-11-03 08:30')).toBe('2026-11-03T08:30');
  });
  it('computes "today" in IST even when UTC is still the previous day', () => {
    expect(istDateString(0, new Date('2026-11-03T19:00:00Z'))).toBe('2026-11-04');
    expect(istDateString(1, new Date('2026-11-03T05:00:00Z'))).toBe('2026-11-04');
    expect(istDateString(0, new Date('2026-11-03T05:00:00Z'))).toBe('2026-11-03');
    expect(istTimestampFilename(new Date('2026-11-03T03:00:00Z'))).toBe('20261103-0830');
  });
});

describe('report export paging', () => {
  beforeEach(() => { vi.resetModules(); });

  it('fetches every page with the same filters until the total is reached', async () => {
    const calls: Array<{ offset: number; limit: number; sessionId: string | null }> = [];
    vi.doMock('../src/lib/api', () => ({
      api: {
        report: async (p: { offset: number; limit: number; sessionId: string | null }) => {
          calls.push({ offset: p.offset, limit: p.limit, sessionId: p.sessionId });
          const total = 2300;
          const n = Math.max(0, Math.min(p.limit, total - p.offset));
          return { report: 'x', columns: ['a'], total, rows: Array.from({ length: n }, (_, i) => ({ a: p.offset + i })) };
        },
      },
    }));
    const { fetchAllReportRows } = await import('../src/lib/reports');
    const progress: number[] = [];
    const res = await fetchAllReportRows({ report: 'session_allocations', sessionId: 'S1', from: null, to: null }, (loaded) => progress.push(loaded));
    expect(res.rows).toHaveLength(2300);
    expect(calls.map((c) => c.offset)).toEqual([0, 1000, 2000]);
    expect(calls.every((c) => c.sessionId === 'S1' && c.limit === 1000)).toBe(true);
    expect(progress).toEqual([1000, 2000, 2300]);
    expect(new Set(res.rows.map((r) => r.a)).size).toBe(2300);
  });

  it('stops on an empty page even if the total is inconsistent (no endless loop)', async () => {
    let n = 0;
    vi.doMock('../src/lib/api', () => ({ api: { report: async () => { n += 1; return { report: 'x', columns: ['a'], total: 999999, rows: n === 1 ? [{ a: 1 }] : [] }; } } }));
    const { fetchAllReportRows } = await import('../src/lib/reports');
    const res = await fetchAllReportRows({ report: 'imports', sessionId: null, from: null, to: null });
    expect(res.rows).toHaveLength(1);
    expect(n).toBeLessThanOrEqual(2);
  });
});

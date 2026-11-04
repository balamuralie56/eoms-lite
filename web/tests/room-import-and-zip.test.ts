// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeRoomsTable } from '../src/lib/roomImportParse';
import { buildZip } from '../src/lib/zip';

const HEADER = ['Room Code', 'Building', 'Floor', 'Capacity'];

describe('normalizeRoomsTable', () => {
  it('maps the required columns case/space/punctuation-insensitively and reports spreadsheet row numbers', () => {
    const r = normalizeRoomsTable([
      ['room code', ' BUILDING ', 'Floor', 'CAPACITY'],
      ['A1', 'Main', '1', '3'],
      ['A2', 'Main', '2', '4'],
    ]);
    expect(r.headerErrors).toEqual([]);
    expect(r.rows.map((x) => [x.row, x.room_code, x.building, x.capacity])).toEqual([
      [2, 'A1', 'Main', '3'], [3, 'A2', 'Main', '4'],
    ]);
  });

  it('Building and Floor are optional', () => {
    const r = normalizeRoomsTable([['Room Code', 'Capacity'], ['A1', '3']]);
    expect(r.headerErrors).toEqual([]);
    expect(r.rows).toEqual([{ row: 2, room_code: 'A1', building: '', floor: '', capacity: '3' }]);
  });

  it('rejects a wrong spreadsheet by naming the missing columns', () => {
    const r = normalizeRoomsTable([['Employee ID', 'Name'], ['E1', 'A']]);
    expect(r.rows).toEqual([]);
    expect(r.headerErrors[0]).toMatch(/Missing columns: Room Code, Capacity/);
  });

  it('ignores extra columns and says which', () => {
    const r = normalizeRoomsTable([[...HEADER, 'Notes'], ['A1', 'Main', '1', '3', 'spare key']]);
    expect(r.ignoredColumns).toEqual(['Notes']);
  });

  it('skips blank rows but keeps the original row numbers', () => {
    const r = normalizeRoomsTable([HEADER, ['A1', '', '', '3'], [null, null, null, null], ['A2', '', '', '4']]);
    expect(r.rows.map((x) => x.row)).toEqual([2, 4]);
    expect(r.blankRowsSkipped).toBe(1);
  });

  it('reports an empty file and a header-only file distinctly', () => {
    expect(normalizeRoomsTable([]).headerErrors).toEqual(['The file is empty.']);
    expect(normalizeRoomsTable([HEADER]).headerErrors).toEqual(['The file has a header but no data rows.']);
  });
});

describe('buildZip', () => {
  it('produces a zip whose local file headers and central directory agree on every entry', async () => {
    const enc = new TextEncoder();
    const blob = buildZip([
      { name: 'a.json', data: enc.encode('{"x":1}') },
      { name: 'README.txt', data: enc.encode('hello world') },
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);

    // End-of-central-directory signature must be present and report 2 entries.
    const eocdOffset = bytes.length - 22;
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(eocdOffset + 10, true)).toBe(2);

    // First local file header: signature, stored (no compression), correct size.
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(0 + 8, true)).toBe(0); // method: stored
    expect(view.getUint32(0 + 22, true)).toBe(enc.encode('{"x":1}').length);
  });

  it('round-trips through the browser-native zip decoder (DecompressionStream / CompressionStream support aside, bytes are literal)', async () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const payload = 'line one\nline two\n';
    const blob = buildZip([{ name: 'rooms.json', data: enc.encode(payload) }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // STORED entries place the raw bytes immediately after the 30-byte local header + filename.
    const nameLen = bytes[26] | (bytes[27] << 8);
    const dataStart = 30 + nameLen;
    const extracted = dec.decode(bytes.slice(dataStart, dataStart + enc.encode(payload).length));
    expect(extracted).toBe(payload);
  });
});

/**
 * Spreadsheet formula-injection defence. A text cell that starts with = + - @ (optionally after spaces/tab/CR) can be
 * executed as a formula when the file is opened in Excel/Sheets. Prefix such text with an apostrophe so it stays text.
 * Numbers and booleans are real typed values and are left alone.
 */
export function neutralizeCell(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return /^[\t\r\n ]*[=+\-@]/.test(s) || /^[\t\r]/.test(s) ? `'${s}` : s;
}

function csvEscape(v: string | number | boolean): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel opens non-ASCII names correctly. */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map((h) => csvEscape(neutralizeCell(h))).join(',')];
  for (const r of rows) lines.push(r.map((c) => csvEscape(neutralizeCell(c))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Safe file name part: keep letters, digits, dot, dash, underscore. */
export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
}

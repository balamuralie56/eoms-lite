import { downloadBlob, neutralizeCell, safeName, toCsv } from './csv';

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportTable {
  /** machine keys in display order */
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

const label = (key: string) => key.replace(/_ist$/, ' (IST)').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function exportFilename(base: string, parts: Array<string | null | undefined>, format: ExportFormat, stamp: string): string {
  const mid = parts.filter(Boolean).map((p) => safeName(String(p))).join('_');
  return `${safeName(base)}${mid ? '_' + mid : ''}_${stamp}.${format}`;
}

export function tableToCsv(t: ExportTable): Blob {
  const text = toCsv(t.columns.map(label), t.rows.map((r) => t.columns.map((c) => r[c])));
  return new Blob([text], { type: 'text/csv;charset=utf-8' });
}

/** XLSX built in the browser. Text cells are neutralised exactly like CSV cells. */
export async function tableToXlsx(t: ExportTable): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const header = t.columns.map((c) => ({ value: label(c), fontWeight: 'bold' as const }));
  const body = t.rows.map((r) => t.columns.map((c) => {
    const v = neutralizeCell(r[c]);
    return typeof v === 'number' ? { value: v, type: Number } : { value: String(v), type: String };
  }));
  return writeXlsxFile([header, ...body] as never).toBlob();
}

/** Builds the file in the chosen format and saves it. Returns the number of data rows. */
export async function downloadTable(t: ExportTable, format: ExportFormat, filename: string): Promise<number> {
  downloadBlob(format === "csv" ? tableToCsv(t) : await tableToXlsx(t), filename);
  return t.rows.length;
}

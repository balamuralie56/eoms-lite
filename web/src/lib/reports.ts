import { api } from './api';
import type { ReportResult } from './types';
import { exportFilename, tableToCsv, tableToXlsx, type ExportFormat } from './export';
import { downloadBlob } from './csv';
import { istTimestampFilename } from './time';

export interface ReportDef {
  key: string;
  label: string;
  description: string;
  /** which filters apply */
  session: boolean;
  dates: boolean;
}

export const REPORTS: ReportDef[] = [
  { key: 'session_allocations', label: 'Session-wise allocations', description: 'Every active allocation in the selected session.', session: true, dates: false },
  { key: 'room_allocations', label: 'Room-wise allocations', description: 'Capacity, allocated and available slots per room.', session: true, dates: false },
  { key: 'employee_allocations', label: 'Employee-wise allocations', description: 'Every scheduled employee with their allocation state.', session: true, dates: false },
  { key: 'unallocated', label: 'Unallocated scheduled employees', description: 'Scheduled employees with no active allocation (pending, flagged or released).', session: true, dates: false },
  { key: 'full_rooms', label: 'Full rooms', description: 'Rooms that have reached their invigilator capacity.', session: true, dates: false },
  { key: 'late_checkins', label: 'Late check-ins', description: 'Late authorizations with reason, authorizer and outcome.', session: true, dates: true },
  { key: 'verification_exceptions', label: 'Verification exceptions', description: 'Flagged employees, resolutions and notes.', session: true, dates: true },
  { key: 'corrections', label: 'Corrections and releases', description: 'Reassigned and released allocations with reasons.', session: true, dates: true },
  { key: 'imports', label: 'Import history', description: 'Schedule import batches with counts.', session: false, dates: true },
];

const PAGE = 1000;
const MAX_PAGES = 50;

export interface ReportParams { report: string; sessionId: string | null; from: string | null; to: string | null }

/** Fetches EVERY page of a report with the same filters (so exports match what the filters select). */
export async function fetchAllReportRows(p: ReportParams, onPage?: (loaded: number, total: number) => void): Promise<ReportResult> {
  let offset = 0;
  let all: ReportResult | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await api.report({ ...p, limit: PAGE, offset });
    if (!all) all = { ...page, rows: [] };
    all.rows.push(...page.rows);
    onPage?.(all.rows.length, page.total);
    offset += PAGE;
    if (offset >= page.total || page.rows.length === 0) break;
  }
  return all as ReportResult;
}

export async function exportReport(p: ReportParams, format: ExportFormat, nameParts: Array<string | null | undefined>,
  onPage?: (loaded: number, total: number) => void): Promise<number> {
  const data = await fetchAllReportRows(p, onPage);
  const table = { columns: data.columns, rows: data.rows };
  const blob = format === 'csv' ? tableToCsv(table) : await tableToXlsx(table);
  downloadBlob(blob, exportFilename(`eoms_${p.report}`, nameParts, format, istTimestampFilename()));
  return data.rows.length;
}

import { useState } from 'react';
import { Download, Search, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useSessions } from '../../context/SessionContext';
import { ErrorBox, errText, useAdminQuery } from '../../lib/adminHooks';
import { useDebounced } from '../../lib/hooks';
import ImportWizard from '../../components/ImportWizard';
import { Badge, Button, Card, DataTable, EmptyState, Input, PageHeader, Pagination, Select, Tabs, useToast, type Column } from '../../components/ui';
import { formatExamDate, formatIst, istTimestampFilename } from '../../lib/time';
import { downloadTable, exportFilename, type ExportFormat } from '../../lib/export';
import type { ImportBatchRow, ScheduleRow } from '../../lib/types';

const PAGE = 25;
const STATE_BADGE = {
  allocated: <Badge tone="green">Allocated</Badge>, pending: <Badge tone="amber">Pending</Badge>,
  flagged: <Badge tone="red">Flagged</Badge>, released: <Badge tone="neutral">Released</Badge>,
} as const;

function ScheduleList({ reloadKey }: { reloadKey: number }) {
  const { sessions, selectedId } = useSessions();
  const { push } = useToast();
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const term = useDebounced(search);
  const sessionId = scope === 'selected' ? selectedId : null;
  const q = useAdminQuery(
    () => api.listSchedule({ sessionId, search: term, status: status || null, limit: PAGE, offset }),
    [sessionId, term, status, offset, reloadKey],
  );
  const sel = sessions.find((s) => s.id === selectedId);

  const doExport = async (format: ExportFormat) => {
    setExporting(true);
    try {
      const rows: ScheduleRow[] = [];
      let off = 0;
      for (let i = 0; i < 20; i++) {
        const page = await api.listSchedule({ sessionId, search: term, status: status || null, limit: 500, offset: off });
        rows.push(...page.rows);
        off += 500;
        if (off >= page.total || page.rows.length === 0) break;
      }
      const table = {
        columns: ['exam_date', 'session', 'employee_id', 'employee_name', 'department', 'status', 'room_code', 'import_file'],
        rows: rows.map((r) => ({ exam_date: r.exam_date, session: r.session_label, employee_id: r.employee_id, employee_name: r.employee_name,
          department: r.department, status: r.state, room_code: r.room_code ?? '', import_file: r.import_filename ?? '' })),
      };
      const parts = [scope === 'selected' && sel ? sel.exam_date : 'all', scope === 'selected' && sel ? sel.session_label : null, status || null, term || null];
      const n = await downloadTable(table, format, exportFilename('eoms_schedule', parts, format, istTimestampFilename()));
      push('success', `Exported ${n} rows`);
    } catch (e) { push('error', errText(e)); }
    finally { setExporting(false); }
  };

  const cols: Column<ScheduleRow>[] = [
    { key: 'id', header: 'Employee ID', cell: (r) => <span className="font-semibold">{r.employee_id}</span> },
    { key: 'name', header: 'Name', cell: (r) => r.employee_name },
    { key: 'dept', header: 'Department', cell: (r) => r.department },
    { key: 'date', header: 'Date', cell: (r) => formatExamDate(r.exam_date) },
    { key: 'sess', header: 'Session', cell: (r) => r.session_label },
    { key: 'status', header: 'Status', cell: (r) => <>{STATE_BADGE[r.state]}{r.room_code && <span className="ml-1 text-xs text-slate-600">{r.room_code}</span>}</> },
    { key: 'batch', header: 'Import', cell: (r) => <span className="text-xs text-slate-600" title={r.import_batch_id ?? ''}>{r.import_filename ?? '-'}</span> },
  ];

  return (
    <Card title="Scheduled invigilators" actions={<>
      <Button variant="secondary" size="sm" loading={exporting} onClick={() => doExport('csv')} data-testid="export-schedule-csv"><Download className="h-4 w-4" aria-hidden />CSV</Button>
      <Button variant="secondary" size="sm" loading={exporting} onClick={() => doExport('xlsx')} data-testid="export-schedule-xlsx"><Download className="h-4 w-4" aria-hidden />XLSX</Button></>}>
      <div className="mb-3 grid gap-2 md:grid-cols-4">
        <div className="relative md:col-span-2"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
          <Input aria-label="Search schedule" placeholder="Search ID, name or department" className="pl-9" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} /></div>
        <Select aria-label="Session scope" value={scope} onChange={(e) => { setScope(e.target.value as 'selected' | 'all'); setOffset(0); }}>
          <option value="selected">Working session{sel ? ` (${sel.exam_date} ${sel.session_label})` : ''}</option><option value="all">All sessions</option></Select>
        <Select aria-label="Status filter" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All statuses</option><option value="allocated">Allocated</option><option value="pending">Pending</option>
          <option value="flagged">Flagged</option><option value="released">Released</option></Select>
      </div>
      <ErrorBox error={q.error} onRetry={q.reload} />
      <DataTable caption="Schedule" columns={cols} rows={q.data?.rows} rowKey={(r) => `${r.employee_id}|${r.exam_date}|${r.session_label}`} loading={q.loading}
        empty={<EmptyState title={term || status ? 'No matching rows' : 'The schedule is empty'}>{term || status ? 'Try a different search or filter.' : 'Import a CSV or XLSX file to load the duty schedule.'}</EmptyState>} />
      {q.data && <Pagination total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />}
    </Card>
  );
}

function ImportHistory({ reloadKey }: { reloadKey: number }) {
  const [offset, setOffset] = useState(0);
  const q = useAdminQuery(() => api.listImports(PAGE, offset), [offset, reloadKey]);
  const tone = (s: string) => (s === 'committed' ? 'green' : s === 'cancelled' ? 'neutral' : s === 'failed' ? 'red' : 'amber');
  const cols: Column<ImportBatchRow>[] = [
    { key: 'file', header: 'File', cell: (r) => <span className="font-semibold">{r.filename}</span> },
    { key: 'status', header: 'Status', cell: (r) => <Badge tone={tone(r.status)}>{r.status}</Badge> },
    { key: 'by', header: 'Uploaded by', cell: (r) => r.uploaded_by_name },
    { key: 'at', header: 'Uploaded', cell: (r) => <span className="text-xs">{formatIst(r.uploaded_at)}</span> },
    { key: 'rows', header: 'Rows', className: 'text-right tabular-nums', cell: (r) => r.row_count },
    { key: 'valid', header: 'Valid', className: 'text-right tabular-nums', cell: (r) => r.valid_count },
    { key: 'inv', header: 'Invalid', className: 'text-right tabular-nums', cell: (r) => r.invalid_count },
    { key: 'dup', header: 'Dup.', className: 'text-right tabular-nums', cell: (r) => r.duplicate_count },
    { key: 'con', header: 'Conflicts', className: 'text-right tabular-nums', cell: (r) => r.conflict_count },
    { key: 'ins', header: 'Inserted', className: 'text-right tabular-nums', cell: (r) => r.inserted_count },
    { key: 'rep', header: 'Replaced', className: 'text-right tabular-nums', cell: (r) => r.replaced_count },
  ];
  return (
    <Card title="Import history">
      <ErrorBox error={q.error} onRetry={q.reload} />
      <DataTable caption="Import batches" columns={cols} rows={q.data?.rows} rowKey={(r) => r.id} loading={q.loading} empty={<EmptyState title="No imports yet" />} />
      {q.data && <Pagination total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />}
    </Card>
  );
}

export default function Schedule() {
  const [tab, setTab] = useState('schedule');
  const [wizard, setWizard] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { refresh } = useSessions();
  return (
    <>
      <PageHeader title="Schedule" subtitle="Who is on duty in which session. Import from CSV or XLSX; nothing is overwritten without your explicit decision."
        actions={<Button onClick={() => setWizard(true)} data-testid="open-import"><Upload className="h-4 w-4" aria-hidden />Import schedule</Button>} />
      <Tabs tabs={[{ key: 'schedule', label: 'Schedule' }, { key: 'history', label: 'Import history' }]} value={tab} onChange={setTab} />
      {tab === 'schedule' ? <ScheduleList reloadKey={reloadKey} /> : <ImportHistory reloadKey={reloadKey} />}
      {wizard && <ImportWizard onClose={() => setWizard(false)} onChanged={() => { setReloadKey((k) => k + 1); void refresh(); }} />}
    </>
  );
}

import { useState } from 'react';
import { Download, Search, Trash2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useSessions } from '../../context/SessionContext';
import { ErrorBox, errText, useAdminQuery } from '../../lib/adminHooks';
import { useDebounced } from '../../lib/hooks';
import ImportWizard from '../../components/ImportWizard';
import { Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Input, PageHeader, Pagination, Select, Tabs, useToast, type Column } from '../../components/ui';
import { formatExamDate, formatIst, istTimestampFilename } from '../../lib/time';
import { downloadTable, exportFilename, type ExportFormat } from '../../lib/export';
import type { ImportBatchRow, ScheduleRow } from '../../lib/types';
import { Tour } from '../../components/tour/Tour';
import { useAutoTour } from '../../components/tour/useAutoTour';
import { TOUR_STEPS } from '../../lib/tourSteps';

const PAGE = 25;
const STATE_BADGE = {
  allocated: <Badge tone="green">Allocated</Badge>, pending: <Badge tone="amber">Pending</Badge>,
  flagged: <Badge tone="red">Flagged</Badge>, released: <Badge tone="neutral">Released</Badge>,
} as const;

function ScheduleList({ reloadKey, onChanged }: { reloadKey: number; onChanged: () => void }) {
  const { sessions, selectedId } = useSessions();
  const { push } = useToast();
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleRow | null>(null);
  const [clearInfo, setClearInfo] = useState<{ would_delete: number; would_skip: number } | null>(null);
  const [clearLoading, setClearLoading] = useState(false);
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

  const canDelete = (r: ScheduleRow) => r.state === 'pending' || r.state === 'released';

  const handleDelete = async (_reason: string) => {
    const r = deleteTarget!;
    await api.deleteScheduleEntry(r.employee_id, r.exam_date, r.session_label);
    push('success', `Removed ${r.employee_id} from schedule`);
    setDeleteTarget(null);
    onChanged();
  };

  const startClear = async () => {
    if (!selectedId) return;
    setClearLoading(true);
    try {
      const res = await api.clearSessionSchedule(selectedId, false);
      setClearInfo({ would_delete: res.would_delete ?? 0, would_skip: res.would_skip ?? 0 });
    } catch (e) { push('error', errText(e)); }
    finally { setClearLoading(false); }
  };

  const handleClear = async (_reason: string) => {
    const res = await api.clearSessionSchedule(selectedId!, true);
    const skipped = res.skipped ?? 0;
    push('success', `Deleted ${res.deleted ?? 0} entries${skipped ? ` (${skipped} skipped — active allocations)` : ''}`);
    setClearInfo(null);
    onChanged();
  };

  const cols: Column<ScheduleRow>[] = [
    { key: 'id', header: 'Employee ID', cell: (r) => <span className="font-semibold">{r.employee_id}</span> },
    { key: 'name', header: 'Name', cell: (r) => r.employee_name },
    { key: 'dept', header: 'Department', cell: (r) => r.department },
    { key: 'date', header: 'Date', cell: (r) => formatExamDate(r.exam_date) },
    { key: 'sess', header: 'Session', cell: (r) => r.session_label },
    { key: 'status', header: 'Status', cell: (r) => <>{STATE_BADGE[r.state]}{r.room_code && <span className="ml-1 text-xs text-slate-600">{r.room_code}</span>}</> },
    { key: 'batch', header: 'Import', cell: (r) => <span className="text-xs text-slate-600" title={r.import_batch_id ?? ''}>{r.import_filename ?? '-'}</span> },
    {
      key: 'del', header: '', className: 'w-10 text-right',
      cell: (r) => (
        <button
          type="button"
          aria-label={`Delete ${r.employee_id}`}
          title={canDelete(r) ? 'Delete entry' : r.state === 'allocated' ? 'Release allocation first' : 'Resolve flag first'}
          disabled={!canDelete(r)}
          onClick={() => setDeleteTarget(r)}
          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      ),
    },
  ];

  return (
    <>
      <Card title="Scheduled invigilators" actions={<>
        {scope === 'selected' && selectedId && (
          <Button variant="danger" size="sm" loading={clearLoading} onClick={startClear} data-testid="clear-session-schedule">
            <Trash2 className="h-4 w-4" aria-hidden />Clear session
          </Button>
        )}
        <Button variant="secondary" size="sm" loading={exporting} onClick={() => doExport('csv')} data-testid="export-schedule-csv"><Download className="h-4 w-4" aria-hidden />CSV</Button>
        <Button variant="secondary" size="sm" loading={exporting} onClick={() => doExport('xlsx')} data-testid="export-schedule-xlsx"><Download className="h-4 w-4" aria-hidden />XLSX</Button>
      </>}>
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

      {deleteTarget && (
        <ConfirmDialog
          title="Delete schedule entry"
          confirmLabel="Delete"
          tone="danger"
          onConfirm={handleDelete}
          onClose={() => setDeleteTarget(null)}
        >
          <p>Permanently remove <strong>{deleteTarget.employee_id}</strong> ({deleteTarget.employee_name}) from the <strong>{formatExamDate(deleteTarget.exam_date)} {deleteTarget.session_label}</strong> schedule?</p>
          <p className="mt-1 text-sm text-slate-500">Allocation history (if any) is not affected.</p>
        </ConfirmDialog>
      )}

      {clearInfo && (
        <ConfirmDialog
          title="Clear session schedule"
          confirmLabel="Delete all"
          tone="danger"
          onConfirm={handleClear}
          onClose={() => setClearInfo(null)}
          confirmDisabled={clearInfo.would_delete === 0}
        >
          <p>
            {clearInfo.would_delete > 0
              ? <>Delete <strong>{clearInfo.would_delete}</strong> schedule {clearInfo.would_delete === 1 ? 'entry' : 'entries'} from the working session?</>
              : 'No entries can be deleted right now.'}
          </p>
          {clearInfo.would_skip > 0 && (
            <p className="mt-1 text-sm text-slate-500">
              {clearInfo.would_skip} {clearInfo.would_skip === 1 ? 'entry' : 'entries'} will be kept — active allocation or unresolved flag.
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
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
  const tour = useAutoTour('schedule', TOUR_STEPS.schedule);
  return (
    <>
      <PageHeader title="Schedule" subtitle="Who is on duty in which session. Import from CSV or XLSX; nothing is overwritten without your explicit decision."
        actions={<Button onClick={() => setWizard(true)} data-testid="open-import"><Upload className="h-4 w-4" aria-hidden />Import schedule</Button>} />
      <Tabs tabs={[{ key: 'schedule', label: 'Schedule' }, { key: 'history', label: 'Import history' }]} value={tab} onChange={setTab} />
      {tab === 'schedule' ? <ScheduleList reloadKey={reloadKey} onChanged={() => { setReloadKey((k) => k + 1); void refresh(); }} /> : <ImportHistory reloadKey={reloadKey} />}
      {wizard && <ImportWizard onClose={() => setWizard(false)} onChanged={() => { setReloadKey((k) => k + 1); void refresh(); }} />}
      {tour.running && <Tour steps={tour.steps} onDone={tour.finish} onSkip={tour.finish} />}
    </>
  );
}

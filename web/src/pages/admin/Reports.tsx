import { useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { api } from '../../lib/api';
import { useSessions } from '../../context/SessionContext';
import { ErrorBox, errText, istDayStart, istNextDayStart, useAdminQuery } from '../../lib/adminHooks';
import { Alert, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Select, useToast, type Column } from '../../components/ui';
import { exportReport, REPORTS } from '../../lib/reports';
import { formatExamDate } from '../../lib/time';
import type { ExportFormat } from '../../lib/export';

const label = (key: string) => key.replace(/_ist$/, ' (IST)').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export default function Reports() {
  const { sessions, selectedId } = useSessions();
  const { push } = useToast();
  const [key, setKey] = useState(REPORTS[0].key);
  const [sessionId, setSessionId] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const def = REPORTS.find((r) => r.key === key)!;
  const effectiveSession = def.session ? (sessionId || selectedId || '') : '';
  const params = {
    report: key, sessionId: effectiveSession || null,
    from: def.dates && from ? istDayStart(from) : null, to: def.dates && to ? istNextDayStart(to) : null,
  };
  const preview = useAdminQuery(() => api.report({ ...params, limit: 50, offset: 0 }), [key, effectiveSession, from, to]);
  const sess = sessions.find((s) => s.id === effectiveSession);

  const doExport = async (format: ExportFormat) => {
    setBusy(format);
    try {
      const n = await exportReport(params, format, [sess?.exam_date, sess?.session_label, from || null, to || null]);
      push('success', `Exported ${n} rows`);
    } catch (e) { push('error', errText(e)); }
    finally { setBusy(null); }
  };

  const cols: Column<Record<string, unknown>>[] = (preview.data?.columns ?? []).map((c) => ({
    key: c, header: label(c), cell: (r) => (r[c] === null || r[c] === undefined || r[c] === '' ? '-' : c === 'exam_date' ? formatExamDate(String(r[c])) : String(r[c])),
  }));

  return (
    <>
      <PageHeader title="Reports and exports" subtitle="Preview a report, then export exactly what the filters select as CSV or XLSX." />
      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <Card title="Reports">
          <ul className="space-y-1" aria-label="Available reports">
            {REPORTS.map((r) => (
              <li key={r.key}>
                <button type="button" aria-pressed={r.key === key} onClick={() => setKey(r.key)} data-testid={`report-${r.key}`}
                  className={`flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm ${r.key === key ? 'bg-blue-50 font-semibold text-blue-900 ring-1 ring-blue-300' : 'text-slate-800 hover:bg-slate-50'}`}>
                  <FileText className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{r.label}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <div className="min-w-0 space-y-4">
          <Card title={def.label}>
            <p className="mb-3 text-sm text-slate-700">{def.description}</p>
            <div className="grid gap-3 md:grid-cols-3">
              {def.session && (
                <Field label="Session" htmlFor="rep-session">
                  <Select id="rep-session" value={effectiveSession} onChange={(e) => setSessionId(e.target.value)}>
                    <option value="">All sessions</option>
                    {sessions.map((s) => <option key={s.id} value={s.id}>{formatExamDate(s.exam_date)} · {s.session_label}</option>)}
                  </Select>
                </Field>)}
              {def.dates && (<>
                <Field label="From (IST date)" htmlFor="rep-from"><Input id="rep-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                <Field label="To (IST date, inclusive)" htmlFor="rep-to"><Input id="rep-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></>)}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => doExport('csv')} loading={busy === 'csv'} disabled={busy !== null} data-testid="export-csv"><Download className="h-4 w-4" aria-hidden />Export CSV</Button>
              <Button variant="secondary" onClick={() => doExport('xlsx')} loading={busy === 'xlsx'} disabled={busy !== null} data-testid="export-xlsx"><Download className="h-4 w-4" aria-hidden />Export XLSX</Button>
            </div>
            <p className="mt-2 text-xs text-slate-600">Text cells starting with = + - or @ are prefixed with an apostrophe so spreadsheets cannot run them as formulas.</p>
          </Card>
          <Card title={`Preview${preview.data ? `: ${preview.data.total} rows` : ''}`}>
            <ErrorBox error={preview.error} onRetry={preview.reload} />
            {preview.data && preview.data.total > 50 && <Alert tone="info" className="mb-3">Showing the first 50 rows. The export contains all {preview.data.total}.</Alert>}
            <DataTable caption={def.label} columns={cols} rows={preview.data?.rows} rowKey={(r) => JSON.stringify(r)} loading={preview.loading}
              empty={<EmptyState title="No rows for these filters" />} />
          </Card>
        </div>
      </div>
    </>
  );
}

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { ErrorBox, errText, istDayStart, istNextDayStart, useAdminQuery } from '../../lib/adminHooks';
import { useDebounced } from '../../lib/hooks';
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Pagination, Select, Skeleton, useToast } from '../../components/ui';
import { formatIst, istTimestampFilename } from '../../lib/time';
import { downloadTable, exportFilename, type ExportFormat } from '../../lib/export';
import type { AuditRow } from '../../lib/types';
import { Tour } from '../../components/tour/Tour';
import { useAutoTour } from '../../components/tour/useAutoTour';
import { TOUR_STEPS } from '../../lib/tourSteps';

const PAGE = 25;

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return <div><p className="text-xs font-semibold uppercase text-slate-600">{label}</p><p className="text-sm text-slate-600">-</p></div>;
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase text-slate-600">{label}</p>
      <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export default function Audit() {
  const { push } = useToast();
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const tour = useAutoTour('audit', TOUR_STEPS.audit);
  const term = useDebounced(search);
  const range = { from: from ? istDayStart(from) : null, to: to ? istNextDayStart(to) : null };
  const q = useAdminQuery(() => api.listAudit({ search: term, action: action || null, ...range, limit: PAGE, offset }), [term, action, from, to, offset]);
  const actions = q.data?.actions ?? [];

  const doExport = async (format: ExportFormat) => {
    setExporting(true);
    try {
      const rows: AuditRow[] = [];
      let off = 0;
      for (let i = 0; i < 20; i++) {
        const page = await api.listAudit({ search: term, action: action || null, ...range, limit: 500, offset: off });
        rows.push(...page.rows); off += 500;
        if (off >= page.total || page.rows.length === 0) break;
      }
      const table = {
        columns: ['id', 'time_ist', 'actor', 'admin', 'action', 'entity', 'entity_id', 'before', 'after', 'request_id'],
        rows: rows.map((r) => ({ id: r.id, time_ist: formatIst(r.at), actor: r.actor, admin: r.admin_name ?? '', action: r.action, entity: r.entity ?? '',
          entity_id: r.entity_id ?? '', before: r.before ? JSON.stringify(r.before) : '', after: r.after ? JSON.stringify(r.after) : '', request_id: r.request_id ?? '' })),
      };
      const n = await downloadTable(table, format, exportFilename('eoms_audit', [from || null, to || null, action || null], format, istTimestampFilename()));
      push('success', `Exported ${n} audit entries`);
    } catch (e) { push('error', errText(e)); }
    finally { setExporting(false); }
  };

  return (
    <>
      <PageHeader title="Audit log" subtitle="Read-only history of every sensitive action. Entries cannot be edited or deleted, by anyone using this application."
        actions={<>
          <Button variant="secondary" loading={exporting} onClick={() => doExport('csv')} data-testid="export-audit-csv"><Download className="h-4 w-4" aria-hidden />CSV</Button>
          <Button variant="secondary" loading={exporting} onClick={() => doExport('xlsx')}><Download className="h-4 w-4" aria-hidden />XLSX</Button></>} />
      <Card>
        <div className="mb-3 grid gap-2 md:grid-cols-4">
          <div className="relative md:col-span-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
            <Input aria-label="Search audit log" placeholder="Search anything" className="pl-9" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} data-testid="audit-search" /></div>
          <Select aria-label="Action filter" value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }}>
            <option value="">All actions</option>{actions.map((a) => <option key={a} value={a}>{a}</option>)}</Select>
          <Field label="From (IST date)" htmlFor="audit-from"><Input id="audit-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} /></Field>
          <Field label="To (IST date, inclusive)" htmlFor="audit-to"><Input id="audit-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} /></Field>
        </div>
        <ErrorBox error={q.error} onRetry={q.reload} />
        {!q.data && q.loading && <Skeleton />}
        {q.data && q.data.rows.length === 0 && <EmptyState title="No audit entries match">Try widening the filters.</EmptyState>}
        {q.data && q.data.rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <caption className="sr-only">Audit log</caption>
              <thead className="bg-slate-50"><tr>
                {['', 'Time (IST)', 'Who', 'Action', 'Entity', 'Reference'].map((h) => <th key={h} scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-700">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {q.data.rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className="hover:bg-slate-50">
                      <td className="px-2 py-2"><button type="button" aria-expanded={open === r.id} aria-label={`${open === r.id ? 'Hide' : 'Show'} details of entry ${r.id}`} onClick={() => setOpen(open === r.id ? null : r.id)} className="rounded p-1 text-slate-600 hover:bg-slate-100">{open === r.id ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}</button></td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">{formatIst(r.at)}</td>
                      <td className="px-3 py-2">{r.admin_name ?? r.actor}<span className="block text-xs text-slate-600">{r.admin_name ? 'Administrator' : r.actor.startsWith('employee:') ? 'Employee check-in' : 'System'}</span></td>
                      <td className="px-3 py-2 font-mono text-xs font-semibold">{r.action}</td>
                      <td className="px-3 py-2 text-xs">{r.entity}<span className="block break-all text-slate-600">{r.entity_id}</span></td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.request_id?.slice(0, 8)}</td>
                    </tr>
                    {open === r.id && (
                      <tr className="bg-slate-50"><td colSpan={6} className="px-4 py-3">
                        <div className="grid gap-3 md:grid-cols-2"><Json label="Before" value={r.before} /><Json label="After" value={r.after} /></div>
                        <p className="mt-2 break-all text-xs text-slate-600">Request reference: {r.request_id ?? '-'}</p>
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {q.data && <Pagination total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />}
      </Card>
      <Alert tone="info" className="mt-4">The audit log is append-only in the database: even the application's own administrator accounts have no permission to change or remove entries.</Alert>
      {tour.running && <Tour steps={tour.steps} onDone={tour.finish} onSkip={tour.finish} />}
    </>
  );
}

import { useCallback, useState, type DragEvent } from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { checkFile } from '../lib/importParse';
import { parseSessionsFile, MAX_ROWS, type ParsedSessionRow, type SessionParseResult } from '../lib/sessionImportParse';
import { errText } from '../lib/adminHooks';
import { Alert, Button, ConfirmDialog, DataTable, Modal, StatCard, useToast, cx } from './ui';

type Step = 'upload' | 'preview' | 'validating' | 'results' | 'report';

interface ImportOutcome {
  rows: number; valid: number; invalid: number;
  errors: Array<{ row: number; exam_date: string; session: string; errors: string[] }>;
  would_create: number; would_skip_existing: number;
}

export default function SessionImportWizard({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { push } = useToast();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<SessionParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [report, setReport] = useState<{ created: number; skipped_existing: number; skipped_overlap: number } | null>(null);

  const rowsAsPayload = (rows: ParsedSessionRow[]) =>
    rows.map((r) => ({ exam_date: r.exam_date, session_label: r.session_label, opens: r.opens, closes: r.closes, active: r.active }));

  const choose = useCallback(async (f: File) => {
    setParseError(null); setParsed(null); setFile(f);
    const head = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
    const check = checkFile(f, head);
    if ('error' in check) { setParseError(check.error); return; }
    setParsing(true);
    try {
      const res = await parseSessionsFile(f);
      if (res.headerErrors.length) { setParseError(res.headerErrors.join(' ')); return; }
      if (res.rows.length > MAX_ROWS) { setParseError(`The file has ${res.rows.length} rows; the limit is ${MAX_ROWS} per import.`); return; }
      setParsed(res); setStep('preview');
    } catch (e) { setParseError(errText(e)); }
    finally { setParsing(false); }
  }, []);

  const validate = async () => {
    if (!parsed) return;
    setStep('validating'); setWorkError(null);
    try {
      const r = await api.importSessions(rowsAsPayload(parsed.rows), false);
      setOutcome({
        rows: r.rows ?? 0, valid: r.valid ?? 0, invalid: r.invalid ?? 0, errors: r.errors ?? [],
        would_create: r.would_create ?? 0, would_skip_existing: r.would_skip_existing ?? 0,
      });
      setStep('results');
    } catch (e) { setWorkError(errText(e)); setStep('preview'); }
  };

  const commit = async () => {
    if (!parsed) return;
    const r = await api.importSessions(rowsAsPayload(parsed.rows), true);
    setReport({ created: r.created ?? 0, skipped_existing: r.skipped_existing ?? 0, skipped_overlap: r.skipped_overlap ?? 0 });
    setStep('report');
    onChanged();
    push('success', 'Sessions imported');
  };

  return (
    <Modal title="Import sessions" onClose={onClose} wide
      footer={step === 'upload' || step === 'report' ? <Button onClick={onClose}>{step === 'report' ? 'Done' : 'Close'}</Button> : undefined}>
      {step === 'upload' && (
        <div className="space-y-3">
          <div
            onDragOver={(e: DragEvent) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
            onDrop={(e: DragEvent) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void choose(f); }}
            className={cx('rounded-xl border-2 border-dashed p-8 text-center', dragOver ? 'border-blue-700 bg-blue-50' : 'border-slate-300')}>
            <FileSpreadsheet className="mx-auto h-10 w-10 text-slate-500" aria-hidden />
            <p className="mt-2 font-semibold text-slate-900">Drop a .csv or .xlsx file here</p>
            <p className="text-sm text-slate-600">or</p>
            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-700">
              <Upload className="h-4 w-4" aria-hidden />Choose file
              <input type="file" accept=".csv,.xlsx" className="sr-only" data-testid="session-import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); e.target.value = ''; }} />
            </label>
            {parsing && <p role="status" className="mt-3 text-sm text-slate-700">Reading {file?.name}…</p>}
          </div>
          {parseError && <Alert tone="error" title="This file cannot be imported">{parseError}</Alert>}
          <Alert tone="info" title="Required columns">
            <p><strong>Examination Date, Session, Check-in Opens, Check-in Closes</strong> are required. <strong>Active</strong> is optional (defaults to active). Opens/Closes are HH:MM in 24-hour Asia/Kolkata time, applied to that row's exam date — a window that crosses midnight needs the single "New session" form instead. Up to {MAX_ROWS} rows per import.</p>
          </Alert>
        </div>
      )}

      {(step === 'preview' || step === 'validating') && parsed && (
        <div className="space-y-3">
          <Alert tone="info" title={`${file?.name}: ${parsed.rows.length} data rows read`}>
            Nothing has been sent yet. {parsed.ignoredColumns.length > 0 && <>Ignored columns: {parsed.ignoredColumns.join(', ')}. </>}{parsed.blankRowsSkipped > 0 && <>{parsed.blankRowsSkipped} blank rows skipped.</>}
          </Alert>
          <DataTable caption="First rows of the file" rows={parsed.rows.slice(0, 20)} rowKey={(r) => String(r.row)}
            columns={[
              { key: 'row', header: 'Row', cell: (r) => r.row }, { key: 'date', header: 'Exam date', cell: (r) => r.exam_date },
              { key: 'sess', header: 'Session', cell: (r) => r.session_label }, { key: 'opens', header: 'Opens', cell: (r) => r.opens },
              { key: 'closes', header: 'Closes', cell: (r) => r.closes }, { key: 'active', header: 'Active', cell: (r) => r.active || '-' },
            ]} />
          {parsed.rows.length > 20 && <p className="text-xs text-slate-600">Showing the first 20 of {parsed.rows.length} rows.</p>}
          {workError && <Alert tone="error" title="Validation could not be completed">{workError}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => { setStep('upload'); setParsed(null); setFile(null); }}>Choose another file</Button>
            <Button onClick={validate} loading={step === 'validating'} data-testid="validate-sessions">Validate with the server</Button>
          </div>
        </div>
      )}

      {step === 'results' && outcome && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="session-validation-summary">
            <StatCard label="Valid" value={outcome.valid} tone="green" hint="Will be processed" />
            <StatCard label="Invalid" value={outcome.invalid} tone={outcome.invalid ? 'red' : undefined} hint="Blocks the import" />
            <StatCard label="New sessions" value={outcome.would_create} tone="green" />
            <StatCard label="Already exist" value={outcome.would_skip_existing} hint="Skipped, never overwritten" />
          </div>
          {outcome.invalid > 0 && (
            <Alert tone="error" title="Fix the file before importing">
              {outcome.invalid} rows have errors. Invalid rows block the whole import so a bad file is never half-imported.
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {outcome.errors.slice(0, 30).map((e) => (
                  <li key={e.row}><strong>Row {e.row}</strong> ({e.exam_date || '(blank)'} {e.session || ''}): {e.errors.join('; ')}</li>
                ))}
              </ul>
              {outcome.errors.length > 30 && <p className="mt-1">…and {outcome.errors.length - 30} more rows.</p>}
            </Alert>
          )}
          {outcome.invalid === 0 && (
            <Alert tone="info">
              {outcome.would_create} new session{outcome.would_create === 1 ? '' : 's'} will be created. {outcome.would_skip_existing} already exist and will be skipped (never overwritten — edit those from the Sessions page). A row whose window overlaps another active session is skipped at import time and reported afterward.
            </Alert>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => { setStep('upload'); setParsed(null); setFile(null); setOutcome(null); }}>Choose another file</Button>
            <Button disabled={outcome.invalid > 0} onClick={() => setConfirming(true)} data-testid="commit-session-import">Import {outcome.would_create} sessions…</Button>
          </div>
        </div>
      )}

      {step === 'report' && report && (
        <div className="space-y-4" data-testid="session-import-report">
          <Alert tone="success" title="Import complete">{report.created} session{report.created === 1 ? '' : 's'} created.</Alert>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Created" value={report.created} tone="green" />
            <StatCard label="Already existed" value={report.skipped_existing} />
            <StatCard label="Skipped (overlap)" value={report.skipped_overlap} tone={report.skipped_overlap ? 'amber' : undefined} />
          </div>
          {report.skipped_overlap > 0 && (
            <Alert tone="warning">{report.skipped_overlap} row{report.skipped_overlap === 1 ? '' : 's'} overlapped another active session's check-in window and were not created. Adjust the window and add them individually.</Alert>
          )}
        </div>
      )}

      {confirming && outcome && (
        <ConfirmDialog title="Import these sessions?" confirmLabel={`Import ${outcome.would_create} sessions`} onClose={() => setConfirming(false)} onConfirm={commit}>
          <p>{outcome.would_create} new examination sessions will be created. {outcome.would_skip_existing} that already exist will be skipped. The data is checked again on the server first, and existing sessions are never overwritten.</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}

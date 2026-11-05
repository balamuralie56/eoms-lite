import { useCallback, useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, FileSpreadsheet, RefreshCw, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { checkFile, MAX_ROWS, type ParseResult } from '../lib/importParse';
import { parseImportFile } from '../lib/parseClient';
import { UploadError, uploadRows } from '../lib/importUpload';
import type { ImportRowOut, ImportSummary } from '../lib/types';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, Modal, Pagination, Select, StatCard, useToast, cx } from './ui';
import { errText } from '../lib/adminHooks';

type Step = 'upload' | 'preview' | 'working' | 'results' | 'report';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'upload', label: '1 · Upload' }, { key: 'preview', label: '2 · Preview' },
  { key: 'results', label: '3 · Validation' }, { key: 'report', label: '4 · Report' },
];

const STATUS_BADGE: Record<string, { tone: 'green' | 'red' | 'amber' | 'neutral'; label: string }> = {
  valid: { tone: 'green', label: 'Valid' }, invalid: { tone: 'red', label: 'Invalid' }, conflict: { tone: 'amber', label: 'Conflict' },
  duplicate_in_batch: { tone: 'neutral', label: 'Duplicate in file' }, exact_duplicate: { tone: 'neutral', label: 'Already scheduled' },
};

export default function ImportWizard({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { push } = useToast();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const [uploadErr, setUploadErr] = useState<UploadError | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [problems, setProblems] = useState<ImportRowOut[]>([]);
  const [problemFilter, setProblemFilter] = useState('problems');
  const [offset, setOffset] = useState(0);
  const [problemTotal, setProblemTotal] = useState(0);
  const [decision, setDecision] = useState<'skip' | 'abort' | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const chunkSize = useRef(500);
  const PAGE = 25;

  const choose = useCallback(async (f: File) => {
    setParseError(null); setParsed(null); setFile(f);
    const head = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
    const check = checkFile(f, head);
    if ('error' in check) { setParseError(check.error); return; }
    setParsing(true);
    try {
      const res = await parseImportFile(f);
      if (res.headerErrors.length) { setParseError(res.headerErrors.join(' ')); return; }
      if (res.rows.length > MAX_ROWS) { setParseError(`The file has ${res.rows.length} rows; the limit is ${MAX_ROWS} per import. Split it into several files.`); return; }
      setParsed(res); setStep('preview');
    } catch (e) { setParseError(errText(e)); }
    finally { setParsing(false); }
  }, []);

  const loadProblems = useCallback(async (id: string, status: string, off: number) => {
    const res = await api.importPreview(id, status, PAGE, off);
    setProblems(res.rows); setSummary(res.summary);
    const s = res.summary;
    setProblemTotal(status === 'problems' ? s.invalid + s.duplicate + s.conflict : status === 'invalid' ? s.invalid : status === 'conflict' ? s.conflict
      : status === 'duplicate_in_batch' ? s.duplicate_in_batch : status === 'exact_duplicate' ? s.exact_duplicate_existing : s.valid);
  }, []);

  const startValidation = async () => {
    if (!parsed || !file) return;
    setWorkError(null); setStep('working');
    try {
      let id = batchId;
      let from = uploadErr?.nextIndex ?? 0;
      if (!id) {
        setProgress({ phase: 'Starting import', done: 0, total: parsed.rows.length });
        const b = await api.importBegin(file.name, file.size, parsed.rows.length);
        id = b.batch_id; setBatchId(id); chunkSize.current = Math.min(500, b.limits.max_chunk_rows); from = 0;
      }
      setUploadErr(null);
      await uploadRows(id, parsed.rows, { chunkSize: chunkSize.current, onProgress: (done, total) => setProgress({ phase: 'Uploading rows', done, total }) },
        undefined, from);
      setProgress({ phase: 'Validating on the server', done: parsed.rows.length, total: parsed.rows.length });
      const v = await api.importValidate(id);
      setSummary(v.summary); setProblems(v.problems);
      await loadProblems(id, 'problems', 0);
      setProblemFilter('problems'); setOffset(0); setDecision(null); setStep('results');
    } catch (e) {
      if (e instanceof UploadError) setUploadErr(e);
      setWorkError(errText(e));
    }
  };

  const doCancel = async () => {
    if (batchId && !committed) { try { await api.importCancel(batchId, 'Cancelled by the administrator before commit'); } catch { /* best effort; maintenance cleans abandoned batches */ } }
    onClose();
  };

  const commit = async () => {
    if (!batchId || !summary) return;
    const res = await api.importCommit(batchId, summary.conflict > 0 ? decision : null);
    if (res.summary) setSummary(res.summary);
    if (res.ok) { setCommitted(true); setCommitMsg(null); setStep('report'); onChanged(); push('success', 'Schedule imported'); return; }
    if (res.code === 'CHANGED_SINCE_PREVIEW') {
      await loadProblems(batchId, 'problems', 0);
      setCommitMsg('The schedule changed while you were reviewing. The numbers above were refreshed. Review them and commit again.');
    } else setCommitMsg(res.message ?? 'The import was not committed.');
    throw new Error(res.message ?? 'The import was not committed.');
  };

  const canCommit = summary && summary.invalid === 0 && summary.valid > 0 && (summary.conflict === 0 || decision !== null);

  return (
    <Modal title="Import schedule" onClose={() => { if (step !== 'working') void doCancel(); }} wide
      footer={step === 'upload' ? <Button variant="secondary" onClick={onClose}>Close</Button> : step === 'report' ? <Button onClick={onClose}>Done</Button> : undefined}>
      <ol className="flex flex-wrap gap-2 text-xs font-semibold" aria-label="Import steps">
        {STEPS.map((s) => (
          <li key={s.key} aria-current={s.key === step || (step === 'working' && s.key === 'preview') ? 'step' : undefined}
            className={cx('rounded-full px-3 py-1', (s.key === step || (step === 'working' && s.key === 'preview')) ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-700')}>{s.label}</li>
        ))}
      </ol>

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
              <input type="file" accept=".csv,.xlsx" className="sr-only" data-testid="import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); e.target.value = ''; }} />
            </label>
            {parsing && <p role="status" className="mt-3 text-sm text-slate-700">Reading {file?.name}…</p>}
          </div>
          {parseError && <Alert tone="error" title="This file cannot be imported">{parseError}</Alert>}
          <Alert tone="info" title="Required columns">
            <p><strong>Employee ID, Name, Department, Examination Date, Session</strong> (FN / AN, or Forenoon / Afternoon). Other columns are ignored. Dates may be real Excel dates, YYYY-MM-DD or DD-MM-YYYY. Up to {MAX_ROWS} rows and 5 MB per import.</p>
          </Alert>
        </div>
      )}

      {(step === 'preview' || step === 'working') && parsed && (
        <div className="space-y-3">
          <Alert tone="info" title={`${file?.name}: ${parsed.rows.length} data rows read`}>
            Nothing has been sent yet. {parsed.ignoredColumns.length > 0 && <>Ignored columns: {parsed.ignoredColumns.join(', ')}. </>}{parsed.blankRowsSkipped > 0 && <>{parsed.blankRowsSkipped} blank rows skipped.</>}
          </Alert>
          <DataTable caption="First rows of the file" rows={parsed.rows.slice(0, 20)} rowKey={(r) => String(r.row)}
            columns={[
              { key: 'row', header: 'Row', cell: (r) => r.row }, { key: 'id', header: 'Employee ID', cell: (r) => r.employee_id },
              { key: 'name', header: 'Name', cell: (r) => r.name }, { key: 'dept', header: 'Department', cell: (r) => r.department },
              { key: 'date', header: 'Date', cell: (r) => r.date }, { key: 'sess', header: 'Session', cell: (r) => r.session },
            ]} />
          {parsed.rows.length > 20 && <p className="text-xs text-slate-600">Showing the first 20 of {parsed.rows.length} rows.</p>}
          {step === 'working' && progress && (
            <div role="status" aria-live="polite" className="space-y-1">
              <p className="text-sm font-semibold text-slate-800">{progress.phase}… {progress.done}/{progress.total}</p>
              <progress className="h-2 w-full" max={progress.total || 1} value={progress.done} />
            </div>
          )}
          {workError && (
            <Alert tone="error" title={uploadErr ? 'The upload was interrupted' : 'Validation could not be completed'}>
              <p>{workError}</p>
              {uploadErr && <p className="mt-1">{uploadErr.nextIndex} of {parsed.rows.length} rows are already safely on the server. Retrying continues from there without creating duplicates.</p>}
            </Alert>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={step === 'working' && !workError} onClick={() => { setStep('upload'); setParsed(null); setFile(null); if (batchId) { void api.importCancel(batchId, 'Replaced by another file').catch(() => undefined); setBatchId(null); setUploadErr(null); } setWorkError(null); }}>Choose another file</Button>
            <Button onClick={startValidation} loading={step === 'working' && !workError} data-testid="start-validation">
              {uploadErr || workError ? <><RefreshCw className="h-4 w-4" aria-hidden />Retry</> : 'Validate with the server'}
            </Button>
          </div>
        </div>
      )}

      {step === 'results' && summary && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="validation-summary">
            <StatCard label="Valid" value={summary.valid} tone="green" hint="Will be imported" />
            <StatCard label="Invalid" value={summary.invalid} tone={summary.invalid ? 'red' : undefined} hint="Blocks the import" />
            <StatCard label="Duplicates" value={summary.duplicate} hint="Skipped" />
            <StatCard label="Conflicts" value={summary.conflict} tone={summary.conflict ? 'amber' : undefined} hint="Differ from the live schedule" />
          </div>
          {summary.invalid > 0 && <Alert tone="error" title="Fix the file before importing">{summary.invalid} rows have errors. Invalid rows block the whole import so a bad file is never half-imported. Correct them in the spreadsheet and upload it again.</Alert>}
          {commitMsg && <Alert tone="warning">{commitMsg}</Alert>}

          <Card title="Rows needing attention" actions={
            <Select id="import-problem-filter" name="import-problem-filter" aria-label="Show rows" className="w-52 !py-1.5" value={problemFilter} onChange={async (e) => { setProblemFilter(e.target.value); setOffset(0); if (batchId) await loadProblems(batchId, e.target.value, 0); }}>
              <option value="problems">All problems</option><option value="invalid">Invalid</option><option value="conflict">Conflicts</option>
              <option value="duplicate_in_batch">Duplicates in file</option><option value="exact_duplicate">Already scheduled</option><option value="valid">Valid rows</option>
            </Select>}>
            <DataTable caption="Validation results by row" rows={problems} rowKey={(r) => String(r.row)}
              empty={<p className="py-6 text-center text-sm text-slate-600">No rows in this category.</p>}
              columns={[
                { key: 'row', header: 'Row', className: 'tabular-nums', cell: (r) => r.row },
                { key: 'status', header: 'Status', cell: (r) => { const b = STATUS_BADGE[r.status] ?? { tone: 'neutral' as const, label: r.status }; return <Badge tone={b.tone}>{b.label}</Badge>; } },
                { key: 'who', header: 'Employee', cell: (r) => <><span className="font-semibold">{r.employee_id || '(blank)'}</span><span className="block text-xs text-slate-600">{r.name}</span></> },
                { key: 'when', header: 'Date · Session', cell: (r) => `${r.date ?? ''} · ${r.session ?? ''}` },
                { key: 'why', header: 'Message', cell: (r) => <ul className="list-disc pl-4">{r.errors.map((m, i) => <li key={i}>{m}</li>)}</ul> },
              ]} />
            <Pagination total={problemTotal} offset={offset} limit={PAGE} onChange={async (o) => { setOffset(o); if (batchId) { const r = await api.importPreview(batchId, problemFilter, PAGE, o); setProblems(r.rows); } }} />
          </Card>

          {summary.conflict > 0 && summary.invalid === 0 && (
            <fieldset className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-4">
              <legend className="px-1 text-sm font-semibold text-amber-950">{summary.conflict} rows conflict with existing schedule entries. What should happen?</legend>
              <label className="flex items-start gap-2 text-sm"><input type="radio" name="decision" className="mt-1" checked={decision === 'skip'} onChange={() => setDecision('skip')} data-testid="decision-skip" />
                <span><strong>Skip the conflicting rows</strong> and import everything else. Existing records are never overwritten.</span></label>
              <label className="flex items-start gap-2 text-sm"><input type="radio" name="decision" className="mt-1" checked={decision === 'abort'} onChange={() => setDecision('abort')} data-testid="decision-abort" />
                <span><strong>Abort the import</strong>. Nothing is imported.</span></label>
            </fieldset>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={doCancel}>Cancel import</Button>
            <Button variant="secondary" onClick={() => { void api.importCancel(batchId!, 'Replaced by another file').catch(() => undefined); setBatchId(null); setStep('upload'); setParsed(null); setFile(null); setSummary(null); setUploadErr(null); }}>Choose another file</Button>
            <Button disabled={!canCommit || decision === 'abort'} onClick={() => setConfirmCommit(true)} data-testid="commit-import">Import {summary.valid} rows…</Button>
            {decision === 'abort' && <Button variant="danger" onClick={doCancel}>Abort import</Button>}
          </div>
        </div>
      )}

      {step === 'report' && summary && (
        <div className="space-y-4" data-testid="import-report">
          <Alert tone="success" title="Import complete">{summary.inserted} rows were added to the schedule.</Alert>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Imported" value={summary.inserted} tone="green" />
            <StatCard label="Skipped duplicates" value={summary.duplicate} />
            <StatCard label="Skipped conflicts" value={summary.conflict} tone={summary.conflict ? 'amber' : undefined} />
            <StatCard label="Replaced" value={summary.replaced} />
          </div>
          {summary.conflict > 0 && summary.replaced === 0 && (
            <Alert tone="warning" title="Conflicting rows were skipped">
              <p>The existing records were kept. If the file is the correct source, you can replace them. This is a separate action that needs a reason and is fully audited with before/after values.</p>
              <Button variant="danger" size="sm" className="mt-2" onClick={() => setConfirmReplace(true)} data-testid="replace-conflicts"><AlertTriangle className="h-4 w-4" aria-hidden />Replace {summary.conflict} conflicting records…</Button>
            </Alert>
          )}
        </div>
      )}

      {confirmCommit && summary && (
        <ConfirmDialog title="Import these rows?" confirmLabel={`Import ${summary.valid} rows`} onClose={() => setConfirmCommit(false)} onConfirm={commit}>
          <p>{summary.valid} new schedule rows will be added from <strong>{file?.name}</strong>. {summary.duplicate} duplicates{summary.conflict > 0 && decision === 'skip' ? ` and ${summary.conflict} conflicts` : ''} will be skipped. The data is checked again on the server first, and the import is all-or-nothing.</p>
        </ConfirmDialog>
      )}
      {confirmReplace && batchId && summary && (
        <ConfirmDialog title="Replace conflicting records?" tone="danger" confirmLabel="Replace records" requireReason onClose={() => setConfirmReplace(false)}
          onConfirm={async (reason) => { const r = await api.importReplaceConflicts(batchId, reason); setSummary(r.summary); push('success', `${r.replaced} records replaced`); onChanged(); }}>
          <p>The name and department of {summary.conflict} existing schedule rows will be overwritten with the values from the file. Each change is recorded with its before and after values.</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}

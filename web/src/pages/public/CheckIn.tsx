import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '../../lib/hooks';
import { ArrowLeft, Building2, CheckCircle2, ChevronDown, Clock, Download, HelpCircle, Loader2, LogIn, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { checkinWithRetry, describeOutcome } from '../../lib/checkin';
import { CHECKIN_HELP } from '../../lib/checkinHelp';
import type { AllocationInfo, CheckinResult, CheckinStatus } from '../../lib/types';
import { useConfig } from '../../context/ConfigContext';
import { Alert, Button, Field, Input, Spinner } from '../../components/ui';
import { formatExamDate, formatIst, formatIstTime, sessionName } from '../../lib/time';
import { canvasToPngBlob, renderSlipCanvas, slipFilename } from '../../lib/slip';
import { downloadBlob } from '../../lib/csv';

const ID_RE = /^[A-Za-z0-9._/-]{1,50}$/;

function Brand() {
  const { config } = useConfig();
  return (
    <header className="bg-yellow-500 text-slate-900">
      <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-4">
        {config.logo_data_url
          ? <img src={config.logo_data_url} alt="" className="h-12 w-12 shrink-0 rounded bg-white object-contain p-1" />
          : <ShieldCheck className="h-10 w-10 shrink-0" aria-hidden />}
        <div className="min-w-0">
          <p className="truncate text-lg font-bold leading-tight">{config.institution_name}</p>
          <p className="truncate text-sm text-slate-800">{config.exam_cell_name}</p>
        </div>
      </div>
    </header>
  );
}

function StatusBanner({ status, failed }: { status: CheckinStatus | undefined; failed: boolean }) {
  if (failed && !status) {
    return <Alert tone="warning" title="Could not check the session status">You can still try to check in.</Alert>;
  }
  if (!status) return <div className="rounded-xl border border-slate-200 bg-white p-4"><Spinner label="Checking session" /></div>;
  if (status.state === 'OPEN') {
    return (
      <div data-testid="status-open" className="rounded-xl border border-green-300 bg-green-50 p-4 text-green-950">
        <p className="flex items-center gap-2 font-semibold"><span className="h-2.5 w-2.5 rounded-full bg-green-600" aria-hidden />Check-in is open</p>
        <p className="mt-1 text-sm">{formatExamDate(status.exam_date)} · {sessionName(status.session)}</p>
        <p className="mt-0.5 flex items-center gap-1 text-sm"><Clock className="h-4 w-4" aria-hidden />Closes at {formatIstTime(status.checkin_closes_at)} IST</p>
      </div>
    );
  }
  return (
    <div data-testid="status-closed" className="rounded-xl border border-slate-300 bg-white p-4">
      <p className="flex items-center gap-2 font-semibold text-slate-800"><span className="h-2.5 w-2.5 rounded-full bg-slate-400" aria-hidden />Check-in is closed</p>
      <p className="mt-1 text-sm text-slate-700">There is no session open for check-in right now.</p>
    </div>
  );
}

function HelpPanel() {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-slate-800 marker:content-none">
        <span className="flex items-center gap-2"><HelpCircle className="h-4 w-4 text-blue-700" aria-hidden />What does my message mean?</span>
        <ChevronDown className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <dl className="space-y-3 border-t border-slate-200 px-4 py-3">
        {CHECKIN_HELP.map((h) => (
          <div key={h.title}>
            <dt className="text-sm font-semibold text-slate-900">{h.title}</dt>
            <dd className="mt-0.5 text-sm text-slate-700">{h.meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">{label}</dt>
      <dd className="break-words font-semibold text-slate-900">{value || '-'}</dd>
    </div>
  );
}

function SlipDownload({ a }: { a: AllocationInfo }) {
  const { config } = useConfig();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const make = async () => {
    setBusy(true); setErr(null);
    try {
      const canvas = await renderSlipCanvas(a, config);
      const blob = await canvasToPngBlob(canvas);
      downloadBlob(blob, slipFilename(a));
      setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create the slip.');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <Button size="lg" className="w-full" onClick={make} loading={busy} data-testid="download-slip">
        <Download className="h-5 w-5" aria-hidden />Download PNG slip
      </Button>
      {err && <Alert tone="error">{err}</Alert>}
      {preview && (
        <div>
          <p className="mb-1 text-xs text-slate-600">If the download did not start, press and hold the image to save it.</p>
          <img src={preview} alt={`Allocation slip for room ${a.room_code}`} className="w-full rounded-lg border border-slate-300" />
        </div>
      )}
    </div>
  );
}

function Success({ r, onBack }: { r: Extract<CheckinResult, { ok: true }>; onBack: () => void }) {
  const { config } = useConfig();
  const o = describeOutcome(r, config);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const where = [r.building, r.floor ? `Floor ${r.floor}` : null].filter(Boolean).join(' · ');
  return (
    <div className="space-y-4" data-testid="result-success" data-code={r.code}>
      <div className="rounded-xl border border-green-300 bg-green-50 p-4 text-green-950" role="status">
        <h1 ref={heading} tabIndex={-1} className="flex items-center gap-2 text-lg font-bold outline-none"><CheckCircle2 className="h-6 w-6 text-green-700" aria-hidden />{o.title}</h1>
        <p className="mt-1 text-sm">{o.body}</p>
      </div>
      <div className="overflow-hidden rounded-2xl border-2 border-blue-700 bg-white text-center shadow">
        <p className="bg-blue-700 py-1.5 text-xs font-bold uppercase tracking-[0.2em] text-white">Your room</p>
        <p data-testid="room-code" className="break-words px-3 py-5 text-6xl font-extrabold leading-none text-blue-950 sm:text-7xl">{r.room_code}</p>
        {where && <p className="flex items-center justify-center gap-1 pb-4 text-base font-semibold text-slate-800"><Building2 className="h-4 w-4" aria-hidden />{where}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <div className="col-span-2"><Detail label="Name" value={r.employee_name ?? ''} /></div>
        <Detail label="Employee ID" value={r.employee_id} />
        <Detail label="Department" value={r.department ?? ''} />
        <Detail label="Examination date" value={formatExamDate(r.exam_date)} />
        <Detail label="Session" value={sessionName(r.session)} />
        <Detail label="Round" value={String(r.round)} />
        <Detail label="Allocated at" value={formatIst(r.allocated_at)} />
        <div className="col-span-2"><Detail label="Reference" value={r.reference} /></div>
      </dl>
      <SlipDownload a={r} />
      <Button variant="secondary" className="w-full" onClick={onBack} data-testid="back-to-checkin"><ArrowLeft className="h-4 w-4" aria-hidden />Back to check-in</Button>
      <p className="text-center text-xs text-slate-600">Going back does not create another allocation. Entering your ID again simply shows this same room.</p>
    </div>
  );
}

export default function CheckIn() {
  const { config } = useConfig();
  const statusQuery = useQuery<CheckinStatus>(() => api.status(), [], { pollMs: 30_000 });
  const status = statusQuery.data;
  const statusFailed = Boolean(statusQuery.error) && !statusQuery.data;
  const [id, setId] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const [result, setResult] = useState<CheckinResult | null>(null);
  const abort = useRef<AbortController | null>(null);

  const refreshStatus = statusQuery.reload;
  useEffect(() => () => abort.current?.abort(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const value = id.trim();
    if (!value) { setFieldError('Please enter your Employee ID.'); return; }
    if (!ID_RE.test(value)) { setFieldError('Use letters, digits and . _ / - only (up to 50 characters).'); return; }
    setFieldError(null); setResult(null); setBusy(true); setRetryNote(null);
    abort.current?.abort();
    abort.current = new AbortController();
    try {
      const { result: r } = await checkinWithRetry(() => api.checkin(value), {
        signal: abort.current.signal,
        onRetry: ({ reason }) => setRetryNote(reason === 'BUSY' ? 'Many people are checking in. Trying again…' : 'Connection problem. Trying again…'),
      });
      setResult(r);
      refreshStatus();
    } catch { /* aborted */ }
    finally { setBusy(false); setRetryNote(null); }
  };

  const back = () => { setResult(null); setId(''); };
  const outcome = result && !result.ok ? describeOutcome(result, config) : null;

  return (
    <div className="min-h-screen bg-slate-100">
      <Brand />
      <main className="mx-auto max-w-xl space-y-4 px-4 py-5">
        {result && result.ok ? (
          <Success r={result} onBack={back} />
        ) : (
          <>
            <h1 className="text-2xl font-bold text-slate-900">{config.app_title}</h1>
            <StatusBanner status={status} failed={statusFailed} />
            <form onSubmit={submit} noValidate className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <Field label="Employee ID" htmlFor="employee-id" error={fieldError} hint="Enter your ID exactly as on your ID card.">
                <Input id="employee-id" name="employee-id" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                  inputMode="text" maxLength={50} value={id} onChange={(e) => { setId(e.target.value); setFieldError(null); }}
                  aria-invalid={Boolean(fieldError)} disabled={busy} data-testid="employee-id" />
              </Field>
              <Button type="submit" size="lg" className="w-full" loading={busy} data-testid="submit-checkin">
                {!busy && <LogIn className="h-5 w-5" aria-hidden />}{busy ? 'Checking in' : 'Check in'}
              </Button>
              {busy && retryNote && <p role="status" className="flex items-center gap-2 text-sm text-slate-700"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{retryNote}</p>}
            </form>
            {outcome && (
              <div data-testid="result-message" data-code={result?.code}>
                <Alert tone={outcome.tone} title={outcome.title}>
                  {outcome.body}
                  {result && !result.ok && result.reference && <span className="mt-1 block font-mono text-xs">Reference: {result.reference}</span>}
                </Alert>
              </div>
            )}
          </>
        )}
        <HelpPanel />
        <footer className="space-y-1 pt-2 text-center text-xs text-slate-600">
          {config.support_info && <p>{config.support_info}</p>}
          <p>Your Employee ID is used only to find your duty. It does not prove who you are; the examination cell may ask you to verify in person.</p>
        </footer>
      </main>
    </div>
  );
}

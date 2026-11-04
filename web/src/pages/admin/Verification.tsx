import { useState, type FormEvent } from 'react';
import { Ban, CheckCircle2, Clock, Flag, Search, UserPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { useSessions } from '../../context/SessionContext';
import { ErrorBox, errText, useAdminQuery } from '../../lib/adminHooks';
import { useDebounced } from '../../lib/hooks';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Input, Modal, PageHeader, Pagination, Select, Tabs, Textarea, useToast, type Column } from '../../components/ui';
import { formatExamDate, formatIst, sessionName } from '../../lib/time';
import type { AuthorizationRow, FlagRow } from '../../lib/types';
import { Tour } from '../../components/tour/Tour';
import { useAutoTour } from '../../components/tour/useAutoTour';
import { TOUR_STEPS } from '../../lib/tourSteps';

const PAGE = 25;

function SessionSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { sessions } = useSessions();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {sessions.map((s) => <option key={s.id} value={s.id}>{formatExamDate(s.exam_date)} · {sessionName(s.session_label)}</option>)}
    </Select>
  );
}

/* ----------------------------------------------------------------- flags */

function FlagDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { selectedId } = useSessions();
  const { push } = useToast();
  const [sid, setSid] = useState(selectedId ?? '');
  const [emp, setEmp] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await api.flagEmployee(emp, sid, reason); push('success', `Employee flagged. Reference ${r.reference}`); onDone(); onClose(); }
    catch (err) { setError(errText(err)); setBusy(false); }
  };
  return (
    <Modal title="Flag an employee for verification" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="flag-form" loading={busy} disabled={!sid || !emp.trim() || reason.trim().length < 3}>Flag employee</Button></>}>
      <form id="flag-form" onSubmit={submit} className="space-y-3">
        <Alert tone="info">A flagged employee cannot check in. They see only “contact the examination cell” and a short reference. Your reason stays internal.</Alert>
        <Field label="Session" htmlFor="f-session"><SessionSelect id="f-session" value={sid} onChange={setSid} /></Field>
        <Field label="Employee ID" htmlFor="f-emp"><Input id="f-emp" required value={emp} onChange={(e) => setEmp(e.target.value)} /></Field>
        <Field label="Reason (internal)" htmlFor="f-reason" hint="Required. Recorded in the audit log."><Textarea id="f-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

function Flags() {
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const [resolve, setResolve] = useState<{ flag: FlagRow; decision: 'cleared' | 'blocked' } | null>(null);
  const { push } = useToast();
  const term = useDebounced(search);
  const q = useAdminQuery(() => api.listFlags({ status: status || null, sessionId: null, search: term, limit: PAGE, offset }), [status, term, offset], { pollMs: 15000 });
  const tone = { pending: 'amber', blocked: 'red', cleared: 'green' } as const;
  const cols: Column<FlagRow>[] = [
    { key: 'emp', header: 'Employee', cell: (f) => <><span className="font-semibold">{f.employee_name ?? f.employee_id}</span><span className="block text-xs text-slate-600">{f.employee_id} · {f.department ?? ''}</span></> },
    { key: 'sess', header: 'Session', cell: (f) => <>{formatExamDate(f.exam_date)}<span className="block text-xs text-slate-600">{f.session_label}</span></> },
    { key: 'reason', header: 'Reason (internal)', cell: (f) => f.reason },
    { key: 'status', header: 'Status', cell: (f) => <><Badge tone={tone[f.status]}>{f.status === 'pending' ? 'Pending' : f.status === 'blocked' ? 'Blocked' : 'Cleared'}</Badge><span className="block font-mono text-xs text-slate-600">Ref {f.reference}</span></> },
    { key: 'hist', header: 'History', cell: (f) => <span className="text-xs text-slate-700">Flagged {formatIst(f.created_at)} by {f.created_by_name}{f.resolved_at && <><br />Resolved {formatIst(f.resolved_at)} by {f.resolved_by_name}{f.resolution_note && <><br />“{f.resolution_note}”</>}</>}</span> },
    {
      key: 'act', header: '', className: 'text-right', cell: (f) => (
        <div className="flex justify-end gap-1">
          {f.status !== 'cleared' && <Button variant="ghost" size="sm" onClick={() => setResolve({ flag: f, decision: 'cleared' })} aria-label={`Clear flag for ${f.employee_id}`}><CheckCircle2 className="h-4 w-4" aria-hidden />Clear</Button>}
          {f.status === 'pending' && <Button variant="ghost" size="sm" onClick={() => setResolve({ flag: f, decision: 'blocked' })} aria-label={`Block ${f.employee_id}`}><Ban className="h-4 w-4" aria-hidden />Block</Button>}
        </div>
      ),
    },
  ];
  return (
    <Card title="Flagged employees" actions={<Button size="sm" onClick={() => setAdding(true)} data-testid="flag-employee"><Flag className="h-4 w-4" aria-hidden />Flag an employee</Button>}>
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="relative min-w-52 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
          <Input aria-label="Search flags" placeholder="Employee ID or name" className="pl-9" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} /></div>
        <Select aria-label="Flag status" className="w-44" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="open">Open (pending + blocked)</option><option value="pending">Pending</option><option value="blocked">Blocked</option><option value="cleared">Cleared</option><option value="">All</option></Select>
      </div>
      <ErrorBox error={q.error} onRetry={q.reload} />
      <DataTable caption="Flagged employees" columns={cols} rows={q.data?.rows} rowKey={(f) => f.id} loading={q.loading}
        empty={<EmptyState title="No flagged employees">Employees you flag for manual verification appear here.</EmptyState>} />
      {q.data && <Pagination total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />}
      {adding && <FlagDialog onClose={() => setAdding(false)} onDone={q.reload} />}
      {resolve && (
        <ConfirmDialog title={resolve.decision === 'cleared' ? `Clear flag for ${resolve.flag.employee_id}?` : `Block ${resolve.flag.employee_id}?`}
          tone={resolve.decision === 'blocked' ? 'danger' : 'primary'} confirmLabel={resolve.decision === 'cleared' ? 'Clear flag' : 'Block employee'}
          requireReason reasonLabel="Resolution note" onClose={() => setResolve(null)}
          onConfirm={async (note) => { await api.resolveFlag(resolve.flag.id, resolve.decision, note); push('success', resolve.decision === 'cleared' ? 'Flag cleared' : 'Employee blocked'); q.reload(); }}>
          {resolve.decision === 'cleared'
            ? <p>The employee can check in normally (all schedule and capacity rules still apply).</p>
            : <p>The employee will not be able to check in to this session. You can clear the block later.</p>}
        </ConfirmDialog>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- late / re-entry */

function AuthorizationList({ kind, reloadKey, onChanged }: { kind: 'late' | 'reentry'; reloadKey: number; onChanged: () => void }) {
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [revoke, setRevoke] = useState<AuthorizationRow | null>(null);
  const { push } = useToast();
  const q = useAdminQuery(() => api.listAuthorizations({ sessionId: null, kind, status: status || null, search: '', limit: PAGE, offset }), [kind, status, offset, reloadKey]);
  const tone = { open: 'blue', consumed: 'green', revoked: 'neutral', expired: 'neutral' } as const;
  const cols: Column<AuthorizationRow>[] = [
    { key: 'emp', header: 'Employee', cell: (a) => <><span className="font-semibold">{a.employee_name ?? a.employee_id}</span><span className="block text-xs text-slate-600">{a.employee_id}</span></> },
    { key: 'sess', header: 'Session', cell: (a) => <>{formatExamDate(a.exam_date)}<span className="block text-xs text-slate-600">{a.session_label}</span></> },
    { key: 'reason', header: 'Reason', cell: (a) => a.reason },
    { key: 'by', header: 'Authorized', cell: (a) => <span className="text-xs">{formatIst(a.authorized_at)}<br />by {a.authorized_by_name}</span> },
    { key: 'status', header: 'Status', cell: (a) => <Badge tone={tone[a.status]}>{a.status === 'open' ? 'Waiting for employee' : a.status === 'consumed' ? 'Used' : a.status[0].toUpperCase() + a.status.slice(1)}</Badge> },
    { key: 'act', header: '', className: 'text-right', cell: (a) => a.status === 'open' && <Button variant="ghost" size="sm" onClick={() => setRevoke(a)} aria-label={`Revoke authorization for ${a.employee_id}`}>Revoke</Button> },
  ];
  return (
    <Card title={kind === 'late' ? 'Late check-in authorizations' : 'Re-entry authorizations'} actions={
      <Select aria-label="Authorization status" className="w-44 !py-1.5" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
        <option value="">All</option><option value="open">Waiting for employee</option><option value="consumed">Used</option><option value="revoked">Revoked</option><option value="expired">Expired</option></Select>}>
      <ErrorBox error={q.error} onRetry={q.reload} />
      <DataTable caption="Authorizations" columns={cols} rows={q.data?.rows} rowKey={(a) => a.id} loading={q.loading} empty={<EmptyState title="No authorizations yet" />} />
      {q.data && <Pagination total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />}
      {revoke && (
        <ConfirmDialog title="Revoke this authorization?" tone="danger" confirmLabel="Revoke" requireReason onClose={() => setRevoke(null)}
          onConfirm={async (reason) => { await api.revokeAuthorization(revoke.id, reason); push('success', 'Authorization revoked'); onChanged(); }}>
          <p>The employee will no longer be able to use this one-time permission.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function AuthorizeForm({ kind, onDone }: { kind: 'late' | 'reentry'; onDone: () => void }) {
  const { selectedId } = useSessions();
  const { push } = useToast();
  const [sid, setSid] = useState(selectedId ?? '');
  const [emp, setEmp] = useState('');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [released, setReleased] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const find = async () => {
    setError(null); setReleased(null);
    try {
      const r = await api.listAllocations({ sessionId: sid, sessionRoomId: null, search: emp.trim(), state: 'released', limit: 5, offset: 0 });
      const hit = r.rows.find((x) => x.employee_id === emp.trim().toUpperCase());
      setReleased(hit ? `Released allocation found: room ${hit.room_code}, reason “${hit.release_reason}”.` : 'No released allocation found for this employee in this session.');
    } catch (e) { setError(errText(e)); }
  };
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (kind === 'late') await api.authorizeLate(emp, sid, reason); else await api.authorizeReentry(emp, sid, reason);
      push('success', 'Authorized. The employee must now submit their Employee ID.');
      setEmp(''); setReason(''); setReleased(null); onDone();
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); setConfirm(false); }
  };
  return (
    <Card title={kind === 'late' ? 'Authorize a late check-in' : 'Authorize re-entry after release'}>
      <p className="mb-3 text-sm text-slate-700">
        {kind === 'late'
          ? 'Normal check-in closes at the configured time. This gives one named employee a one-time permission to check in anyway. The employee must be on the schedule; flags and room capacity still apply.'
          : 'A released employee cannot silently check in again. This gives them a one-time permission to be allocated again. Room capacity still applies.'}
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Session" htmlFor={`${kind}-session`}><SessionSelect id={`${kind}-session`} value={sid} onChange={setSid} /></Field>
        <Field label="Employee ID" htmlFor={`${kind}-emp`}><Input id={`${kind}-emp`} value={emp} onChange={(e) => { setEmp(e.target.value); setReleased(null); }} data-testid={`${kind}-emp`} /></Field>
        <div className="flex items-end">{kind === 'reentry' && <Button variant="secondary" onClick={find} disabled={!emp.trim() || !sid} className="w-full">Find released allocation</Button>}</div>
      </div>
      {released && <Alert className="mt-3" tone={released.startsWith('Released') ? 'info' : 'warning'}>{released}</Alert>}
      <Field label="Reason" htmlFor={`${kind}-reason`} hint="Required, at least 3 characters. Recorded in the audit log."><Textarea id={`${kind}-reason`} rows={2} className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} data-testid={`${kind}-reason`} /></Field>
      {error && <Alert className="mt-3" tone="error">{error}</Alert>}
      <div className="mt-3 flex justify-end">
        <Button onClick={() => setConfirm(true)} disabled={!sid || !emp.trim() || reason.trim().length < 3} data-testid={`${kind}-authorize`}>{kind === 'late' ? <Clock className="h-4 w-4" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}Authorize…</Button>
      </div>
      {confirm && (
        <ConfirmDialog title={kind === 'late' ? 'Authorize late check-in?' : 'Authorize re-entry?'} confirmLabel="Authorize" onClose={() => setConfirm(false)} onConfirm={submit}>
          <p>Employee <strong>{emp.trim().toUpperCase()}</strong> will get a one-time permission. Reason: “{reason.trim()}”.</p>
        </ConfirmDialog>
      )}
      {busy && <p className="sr-only" role="status">Working</p>}
    </Card>
  );
}

export default function Verification() {
  const [tab, setTab] = useState('flags');
  const [key, setKey] = useState(0);
  const bump = () => setKey((k) => k + 1);
  const tour = useAutoTour('verification', TOUR_STEPS.verification);
  return (
    <>
      <PageHeader title="Verification and exceptions" subtitle="Manual verification, late arrivals and re-entry. Employees cannot clear these themselves, and the employee ID alone is not proof of identity." />
      <Tabs tabs={[{ key: 'flags', label: 'Flagged employees' }, { key: 'late', label: 'Late check-in' }, { key: 'reentry', label: 'Re-entry' }]} value={tab} onChange={setTab} />
      {tab === 'flags' && <Flags />}
      {tab === 'late' && <div className="space-y-5"><AuthorizeForm kind="late" onDone={bump} /><AuthorizationList kind="late" reloadKey={key} onChanged={bump} /></div>}
      {tab === 'reentry' && <div className="space-y-5"><AuthorizeForm kind="reentry" onDone={bump} /><AuthorizationList kind="reentry" reloadKey={key} onChanged={bump} /></div>}
      {tour.running && <Tour steps={tour.steps} onDone={tour.finish} onSkip={tour.finish} />}
    </>
  );
}

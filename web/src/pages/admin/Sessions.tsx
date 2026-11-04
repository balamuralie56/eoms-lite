import { useState, type FormEvent } from 'react';
import { Pencil, Plus, Power, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useSessions } from '../../context/SessionContext';
import { errText } from '../../lib/adminHooks';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Input, Modal, PageHeader, Select, useToast, type Column } from '../../components/ui';
import { apiToLocalInput, formatExamDate, formatIstTime, istDateString, localInputToApi, sessionName } from '../../lib/time';
import type { SessionSummary } from '../../lib/types';
import { Tour } from '../../components/tour/Tour';
import { useAutoTour } from '../../components/tour/useAutoTour';
import { TOUR_STEPS } from '../../lib/tourSteps';
import SessionImportWizard from '../../components/SessionImportWizard';

const TONE = { OPEN: 'green', UPCOMING: 'blue', CLOSED: 'neutral', INACTIVE: 'amber' } as const;

function SessionForm({ existing, onClose, onSaved }: { existing?: SessionSummary; onClose: () => void; onSaved: () => void }) {
  const locked = Boolean(existing && (existing.scheduled > 0 || existing.allocated > 0));
  const [date, setDate] = useState(existing?.exam_date ?? istDateString(1));
  const [label, setLabel] = useState<string>(existing?.session_label ?? 'FN');
  const [opens, setOpens] = useState(existing ? apiToLocalInput(existing.opens_ist) : `${istDateString(1)}T07:30`);
  const [closes, setCloses] = useState(existing ? apiToLocalInput(existing.closes_ist) : `${istDateString(1)}T10:00`);
  const [active, setActive] = useState(existing?.is_active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (existing) {
        await api.updateSession(existing.id, locked ? { opens: localInputToApi(opens), closes: localInputToApi(closes) }
          : { date, label, opens: localInputToApi(opens), closes: localInputToApi(closes) });
      } else {
        await api.createSession({ date, label, opens: localInputToApi(opens), closes: localInputToApi(closes), active });
      }
      onSaved(); onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  };

  return (
    <Modal title={existing ? 'Edit session' : 'New examination session'} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="session-form" loading={busy}>{existing ? 'Save changes' : 'Create session'}</Button></>}>
      <form id="session-form" onSubmit={submit} className="space-y-4">
        <Alert tone="info">All times are <strong>Asia/Kolkata (IST)</strong>. Check-in is open from the opening time up to, but not including, the closing time. Active sessions cannot overlap.</Alert>
        {locked && <Alert tone="warning">The schedule or allocations already reference this session, so its date and FN/AN cannot change. You can still adjust the check-in window.</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Examination date" htmlFor="s-date"><Input id="s-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} disabled={locked} /></Field>
          <Field label="Session" htmlFor="s-label">
            <Select id="s-label" value={label} onChange={(e) => setLabel(e.target.value)} disabled={locked}>
              <option value="FN">Forenoon (FN)</option><option value="AN">Afternoon (AN)</option>
            </Select>
          </Field>
          <Field label="Check-in opens (IST)" htmlFor="s-opens"><Input id="s-opens" type="datetime-local" required value={opens} onChange={(e) => setOpens(e.target.value)} /></Field>
          <Field label="Check-in closes (IST)" htmlFor="s-closes"><Input id="s-closes" type="datetime-local" required value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
        </div>
        {!existing && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4" />Active (employees can check in during the window)</label>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

export default function Sessions() {
  const { sessions, loading, refresh, select } = useSessions();
  const { push } = useToast();
  const [form, setForm] = useState<{ existing?: SessionSummary } | null>(null);
  const [toggle, setToggle] = useState<SessionSummary | null>(null);
  const [filter, setFilter] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const tour = useAutoTour('sessions', TOUR_STEPS.sessions);

  const rows = sessions.filter((s) => !filter || (filter === 'active' ? s.is_active : filter === 'inactive' ? !s.is_active : s.state === filter));

  const cols: Column<SessionSummary>[] = [
    { key: 'date', header: 'Date', cell: (s) => <span className="font-semibold">{formatExamDate(s.exam_date)}</span> },
    { key: 'sess', header: 'Session', cell: (s) => sessionName(s.session_label) },
    { key: 'window', header: 'Check-in window (IST)', cell: (s) => <span className="tabular-nums">{formatIstTime(s.checkin_opens_at)} – {formatIstTime(s.checkin_closes_at)}</span> },
    { key: 'state', header: 'Status', cell: (s) => <Badge tone={TONE[s.state]}>{s.state === 'OPEN' ? 'Open now' : s.state[0] + s.state.slice(1).toLowerCase()}</Badge> },
    { key: 'sch', header: 'Scheduled', className: 'text-right tabular-nums', cell: (s) => s.scheduled },
    { key: 'alloc', header: 'Allocated', className: 'text-right tabular-nums', cell: (s) => `${s.allocated} / ${s.total_slots}` },
    {
      key: 'act', header: '', className: 'text-right', cell: (s) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" aria-label={`Edit session ${s.exam_date} ${s.session_label}`} onClick={() => setForm({ existing: s })}><Pencil className="h-4 w-4" aria-hidden />Edit</Button>
          <Button variant="ghost" size="sm" aria-label={`${s.is_active ? 'Deactivate' : 'Activate'} session ${s.exam_date} ${s.session_label}`} onClick={() => setToggle(s)}><Power className="h-4 w-4" aria-hidden />{s.is_active ? 'Deactivate' : 'Activate'}</Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Examination sessions" subtitle="Configure when check-in opens and closes. FN and AN are independent sessions."
        actions={<div className="flex gap-2">
          <Button variant="secondary" onClick={() => setImportOpen(true)} data-testid="import-sessions"><Upload className="h-4 w-4" aria-hidden />Import sessions</Button>
          <Button onClick={() => setForm({})} data-testid="new-session"><Plus className="h-4 w-4" aria-hidden />New session</Button>
        </div>} />
      <Card title="Session history" actions={
        <Select aria-label="Filter sessions" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-40 !py-1.5">
          <option value="">All sessions</option><option value="OPEN">Open now</option><option value="UPCOMING">Upcoming</option>
          <option value="CLOSED">Closed</option><option value="active">Active</option><option value="inactive">Inactive</option>
        </Select>}>
        <DataTable caption="Examination sessions" columns={cols} rows={rows} rowKey={(s) => s.id} loading={loading}
          empty={<EmptyState title="No sessions">Create the first examination session to begin.</EmptyState>} />
      </Card>
      {importOpen && <SessionImportWizard onClose={() => setImportOpen(false)} onChanged={() => { void refresh(); }} />}
      {form &&<SessionForm existing={form.existing} onClose={() => setForm(null)} onSaved={() => { void refresh(); }} />}
      {toggle && (
        <ConfirmDialog
          title={toggle.is_active ? 'Deactivate session?' : 'Activate session?'}
          tone={toggle.is_active ? 'danger' : 'primary'}
          confirmLabel={toggle.is_active ? 'Deactivate' : 'Activate'}
          requireReason
          onClose={() => setToggle(null)}
          onConfirm={async (reason) => {
            await api.setSessionActive(toggle.id, !toggle.is_active, reason, toggle.is_active && toggle.allocated > 0);
            push('success', toggle.is_active ? 'Session deactivated' : 'Session activated');
            await refresh(); select(toggle.id);
          }}>
          {toggle.is_active
            ? <p>While inactive, <strong>no one can check in</strong> to {formatExamDate(toggle.exam_date)} {toggle.session_label}.{toggle.allocated > 0 && <> This session has <strong>{toggle.allocated} active allocations</strong>; they stay in place.</>}</p>
            : <p>Employees will be able to check in during the configured window. Activation is refused if the window overlaps another active session.</p>}
        </ConfirmDialog>
      )}
      {tour.running && <Tour steps={tour.steps} onDone={tour.finish} onSkip={tour.finish} />}
    </>
  );
}

import { useState } from 'react';
import { History, Repeat, Search, UserMinus, UserPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { useSessions } from '../../context/SessionContext';
import { ErrorBox, useAdminQuery } from '../../lib/adminHooks';
import { useDebounced } from '../../lib/hooks';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Input, Modal, PageHeader, Pagination, Select, useToast, type Column } from '../../components/ui';
import { formatExamDate, formatIst } from '../../lib/time';
import type { AllocationRow, RoomMonitorRow } from '../../lib/types';
import { Tour } from '../../components/tour/Tour';
import { useAutoTour } from '../../components/tour/useAutoTour';
import { TOUR_STEPS } from '../../lib/tourSteps';

const PAGE = 25;
const SOURCE: Record<string, string> = { normal: 'Check-in', admin_late: 'Late (authorized)', admin_reentry: 'Re-entry (authorized)', admin_correction: 'Correction' };

function HistoryDialog({ row, onClose }: { row: AllocationRow; onClose: () => void }) {
  const q = useAdminQuery(() => api.allocationHistory(row.session_id, row.employee_id), [row.session_id, row.employee_id]);
  return (
    <Modal title={`History: ${row.employee_name ?? row.employee_id}`} onClose={onClose} wide footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <p className="text-sm text-slate-700">Every allocation made for {row.employee_id} in {formatExamDate(row.exam_date)} {row.session_label}, oldest first. Corrections never overwrite earlier rows.</p>
      <ErrorBox error={q.error} onRetry={q.reload} />
      <DataTable caption="Allocation history" rows={q.data} rowKey={(h) => h.id} loading={q.loading}
        columns={[
          { key: 'room', header: 'Room', cell: (h) => <span className="font-semibold">{h.room_code}</span> },
          { key: 'src', header: 'How', cell: (h) => SOURCE[h.source] ?? h.source },
          { key: 'at', header: 'Allocated', cell: (h) => <span className="text-xs">{formatIst(h.allocated_at)}</span> },
          { key: 'by', header: 'By', cell: (h) => h.created_by ?? 'Employee' },
          { key: 'state', header: 'State', cell: (h) => (h.released_at ? <><Badge tone="neutral">Ended</Badge><span className="block text-xs text-slate-600">{formatIst(h.released_at)} · {h.released_by}<br />{h.release_reason}</span></> : <Badge tone="green">Current</Badge>) },
        ]} />
    </Modal>
  );
}

function ReassignDialog({ row, onClose, onDone }: { row: AllocationRow; onClose: () => void; onDone: () => void }) {
  const rooms = useAdminQuery(() => api.roomMonitor(row.session_id), [row.session_id]);
  const eligible = (rooms.data ?? []).filter((r: RoomMonitorRow) => r.status === 'available' && r.session_room_id !== row.session_room_id);
  const [target, setTarget] = useState('');
  const { push } = useToast();
  return (
    <ConfirmDialog title={`Move ${row.employee_name ?? row.employee_id} to another room`} confirmLabel="Move employee" requireReason onClose={onClose}
      confirmDisabled={!target}
      onConfirm={async (reason) => { await api.reassign(row.id, target, reason); push('success', 'Allocation corrected'); onDone(); }}
      extra={
        <Field label="New room" htmlFor="target-room" hint="Only active rooms with free slots are listed. The previous allocation is kept in the history.">
          {rooms.loading ? <p className="text-sm text-slate-600">Loading rooms…</p> : eligible.length === 0 ? <Alert tone="warning">No other room has a free slot.</Alert> : (
            <Select id="target-room" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a room…</option>
              {eligible.map((r) => <option key={r.session_room_id} value={r.session_room_id}>{r.room_code} ({r.available} free of {r.capacity})</option>)}
            </Select>)}
        </Field>}>
      <p>Currently in room <strong>{row.room_code}</strong>. The employee will see the new room the next time they enter their ID.</p>
      {!target && <p className="mt-2 text-xs text-amber-800">Choose a target room to continue. The database re-checks capacity regardless.</p>}
    </ConfirmDialog>
  );
}

export default function Allocations() {
  const { selectedId, sessions } = useSessions();
  const { push } = useToast();
  const [scope, setScope] = useState<'selected' | 'all'>('selected');
  const [state, setState] = useState('active');
  const [roomId, setRoomId] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [hist, setHist] = useState<AllocationRow | null>(null);
  const [move, setMove] = useState<AllocationRow | null>(null);
  const [release, setRelease] = useState<AllocationRow | null>(null);
  const [reentry, setReentry] = useState<AllocationRow | null>(null);
  const tour = useAutoTour('allocations', TOUR_STEPS.allocations);
  const term = useDebounced(search);
  const sessionId = scope === 'selected' ? selectedId : null;
  const rooms = useAdminQuery(() => (sessionId ? api.roomMonitor(sessionId) : Promise.resolve([] as RoomMonitorRow[])), [sessionId]);
  const q = useAdminQuery(
    () => api.listAllocations({ sessionId, sessionRoomId: roomId || null, search: term, state, limit: PAGE, offset }),
    [sessionId, roomId, term, state, offset], { pollMs: 15000 },
  );
  const sel = sessions.find((s) => s.id === selectedId);

  const cols: Column<AllocationRow>[] = [
    { key: 'emp', header: 'Employee', cell: (r) => <><span className="font-semibold">{r.employee_name ?? '(not in schedule)'}</span><span className="block text-xs text-slate-600">{r.employee_id} · {r.department ?? ''}</span></> },
    { key: 'sess', header: 'Session', cell: (r) => <>{formatExamDate(r.exam_date)}<span className="block text-xs text-slate-600">{r.session_label}</span></> },
    { key: 'room', header: 'Room', cell: (r) => <><span className="font-semibold">{r.room_code}</span><span className="block text-xs text-slate-600">Round {r.round}</span></> },
    { key: 'src', header: 'How', cell: (r) => SOURCE[r.source] ?? r.source },
    { key: 'at', header: 'Allocated', cell: (r) => <span className="text-xs">{formatIst(r.allocated_at)}</span> },
    { key: 'state', header: 'State', cell: (r) => (r.released_at ? <><Badge tone="neutral">Released</Badge><span className="block text-xs text-slate-600" title={r.release_reason ?? ''}>{r.release_reason}</span></> : <Badge tone="green">Active</Badge>) },
    {
      key: 'act', header: '', className: 'text-right', cell: (r) => (
        <div className="flex flex-wrap justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setHist(r)} aria-label={`History for ${r.employee_id}`}><History className="h-4 w-4" aria-hidden />History</Button>
          {!r.released_at && <Button variant="ghost" size="sm" onClick={() => setMove(r)} aria-label={`Move ${r.employee_id}`}><Repeat className="h-4 w-4" aria-hidden />Move</Button>}
          {!r.released_at && <Button variant="ghost" size="sm" onClick={() => setRelease(r)} aria-label={`Release ${r.employee_id}`}><UserMinus className="h-4 w-4" aria-hidden />Release</Button>}
          {r.released_at && <Button variant="ghost" size="sm" onClick={() => setReentry(r)} aria-label={`Authorize re-entry for ${r.employee_id}`}><UserPlus className="h-4 w-4" aria-hidden />Re-entry</Button>}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Allocations" subtitle="Find an employee, move them to another eligible room, or release their allocation. Every change is audited and history is preserved." />
      <Card>
        <div className="mb-3 grid gap-2 md:grid-cols-5">
          <div className="relative md:col-span-2"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
            <Input aria-label="Search by employee ID or name" placeholder="Employee ID or name" className="pl-9" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} data-testid="alloc-search" /></div>
          <Select aria-label="Session scope" value={scope} onChange={(e) => { setScope(e.target.value as 'selected' | 'all'); setRoomId(''); setOffset(0); }}>
            <option value="selected">Working session{sel ? ` (${sel.exam_date} ${sel.session_label})` : ''}</option><option value="all">All sessions</option></Select>
          <Select aria-label="Room filter" value={roomId} disabled={!sessionId} onChange={(e) => { setRoomId(e.target.value); setOffset(0); }}>
            <option value="">All rooms</option>{(rooms.data ?? []).map((r) => <option key={r.session_room_id} value={r.session_room_id}>{r.room_code}</option>)}</Select>
          <Select aria-label="State filter" value={state} onChange={(e) => { setState(e.target.value); setOffset(0); }}>
            <option value="active">Active</option><option value="released">Released</option><option value="all">All</option></Select>
        </div>
        <ErrorBox error={q.error} onRetry={q.reload} />
        <DataTable caption="Allocations" columns={cols} rows={q.data?.rows} rowKey={(r) => r.id} loading={q.loading}
          empty={<EmptyState title="No allocations found">{term || roomId || state !== 'active' ? 'Try changing the filters.' : 'Allocations appear here as employees check in.'}</EmptyState>} />
        {q.data && <Pagination total={q.data.total} offset={offset} limit={PAGE} onChange={setOffset} />}
      </Card>

      {hist && <HistoryDialog row={hist} onClose={() => setHist(null)} />}
      {move && <ReassignDialog row={move} onClose={() => setMove(null)} onDone={q.reload} />}
      {release && (
        <ConfirmDialog title={`Release ${release.employee_name ?? release.employee_id}?`} tone="danger" confirmLabel="Release allocation" requireReason onClose={() => setRelease(null)}
          onConfirm={async (reason) => { await api.release(release.id, reason); push('success', 'Allocation released'); q.reload(); }}>
          <p>Room <strong>{release.room_code}</strong> gets a free slot. The employee cannot simply check in again: re-entry then needs your explicit authorization.</p>
        </ConfirmDialog>
      )}
      {reentry && (
        <ConfirmDialog title={`Authorize re-entry for ${reentry.employee_name ?? reentry.employee_id}`} confirmLabel="Authorize re-entry" requireReason onClose={() => setReentry(null)}
          onConfirm={async (reason) => { await api.authorizeReentry(reentry.employee_id, reentry.session_id, reason); push('success', 'Re-entry authorized. The employee can now submit their ID.'); }}>
          <p>This is a <strong>one-time permission</strong>. The employee then submits their Employee ID normally and the allocation engine still applies room and capacity rules.</p>
        </ConfirmDialog>
      )}
      {tour.running && <Tour steps={tour.steps} onDone={tour.finish} onSkip={tour.finish} />}
    </>
  );
}

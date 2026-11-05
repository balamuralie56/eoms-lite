import { useMemo, useState, type FormEvent } from 'react';
import { Pencil, Plus, Power, Search, Trash2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { useSessions } from '../../context/SessionContext';
import { ErrorBox, errText, useAdminQuery } from '../../lib/adminHooks';
import { Alert, Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, Field, Input, Modal, PageHeader, Select, useToast, type Column } from '../../components/ui';
import { formatExamDate } from '../../lib/time';
import type { RoomMonitorRow, RoomRow } from '../../lib/types';
import { roomStatusBadge } from './Dashboard';
import { Tour } from '../../components/tour/Tour';
import { useAutoTour } from '../../components/tour/useAutoTour';
import { TOUR_STEPS } from '../../lib/tourSteps';
import RoomImportWizard from '../../components/RoomImportWizard';

function CapacityDialog({ row, onClose, onDone }: { row: RoomMonitorRow; onClose: () => void; onDone: () => void }) {
  const [cap, setCap] = useState(String(row.capacity));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.updateSessionRoom(row.session_room_id, Number(cap)); push('success', 'Capacity updated'); onDone(); onClose(); }
    catch (err) { setError(errText(err)); setBusy(false); }
  };
  return (
    <Modal title={`Invigilator capacity: ${row.room_code}`} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="cap-form" loading={busy}>Save capacity</Button></>}>
      <form id="cap-form" onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-700">This is the <strong>maximum number of invigilators</strong> for this room in this session (not student seating). It currently holds <strong>{row.allocated}</strong> active allocations and cannot be set lower than that.</p>
        <Field label="Maximum invigilators" htmlFor="cap" hint="1 to 100"><Input id="cap" type="number" min={Math.max(1, row.allocated)} max={100} required value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

function AssignDialog({ sessionId, rooms, assignedIds, onClose, onDone }: { sessionId: string; rooms: RoomRow[]; assignedIds: Set<string>; onClose: () => void; onDone: () => void }) {
  const available = rooms.filter((r) => !assignedIds.has(r.id));
  const [roomId, setRoomId] = useState(available[0]?.id ?? '');
  const [cap, setCap] = useState('2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { push } = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.assignRoom(sessionId, roomId, Number(cap)); push('success', 'Room assigned to the session'); onDone(); onClose(); }
    catch (err) { setError(errText(err)); setBusy(false); }
  };
  return (
    <Modal title="Assign a room to this session" onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="assign-form" loading={busy} disabled={!roomId}>Assign room</Button></>}>
      <form id="assign-form" onSubmit={submit} className="space-y-3">
        {available.length === 0
          ? <Alert tone="info">Every room is already assigned. Create a new room first.</Alert>
          : (<>
            <Field label="Room" htmlFor="a-room"><Select id="a-room" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {available.map((r) => <option key={r.id} value={r.id}>{r.room_code}{r.building ? ` · ${r.building}` : ''}{r.is_active ? '' : ' (inactive)'}</option>)}
            </Select></Field>
            <Field label="Maximum invigilators for this session" htmlFor="a-cap" hint="Invigilator capacity, not student seating. 1 to 100."><Input id="a-cap" type="number" min={1} max={100} required value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
          </>)}
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

function RoomForm({ existing, onClose, onDone }: { existing?: RoomRow; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(existing?.room_code ?? '');
  const [building, setBuilding] = useState(existing?.building ?? '');
  const [floor, setFloor] = useState(existing?.floor ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const { push } = useToast();
  const inUse = (existing?.active_allocations ?? 0) > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      if (existing) await api.updateRoom(existing.id, { code, building, floor, confirm });
      else await api.createRoom(code, building || null, floor || null);
      push('success', existing ? 'Room updated' : 'Room created'); onDone(); onClose();
    } catch (err) { setError(errText(err)); setBusy(false); }
  };
  return (
    <Modal title={existing ? `Edit room ${existing.room_code}` : 'New room'} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="room-form" loading={busy}>{existing ? 'Save changes' : 'Create room'}</Button></>}>
      <form id="room-form" onSubmit={submit} className="space-y-3">
        <Field label="Room code" htmlFor="r-code" hint="Shown to employees. Stored in capitals. Must be unique."><Input id="r-code" required maxLength={50} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Building" htmlFor="r-building"><Input id="r-building" maxLength={100} value={building} onChange={(e) => setBuilding(e.target.value)} /></Field>
          <Field label="Floor" htmlFor="r-floor"><Input id="r-floor" maxLength={100} value={floor} onChange={(e) => setFloor(e.target.value)} /></Field>
        </div>
        {inUse && (
          <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>This room has <strong>{existing!.active_allocations} active allocations</strong> whose slips show the current code, building and floor. Tick to confirm you want to change them.</span>
          </label>
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Modal>
  );
}

export default function Rooms() {
  const { selectedId, selected } = useSessions();
  const { push } = useToast();
  const monitor = useAdminQuery(() => (selectedId ? api.roomMonitor(selectedId) : Promise.resolve([] as RoomMonitorRow[])), [selectedId], { pollMs: 10000 });
  const all = useAdminQuery(() => api.listRooms(), []);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [rq, setRq] = useState('');
  const [cap, setCap] = useState<RoomMonitorRow | null>(null);
  const [assign, setAssign] = useState(false);
  const [roomForm, setRoomForm] = useState<{ existing?: RoomRow } | null>(null);
  const [linkToggle, setLinkToggle] = useState<RoomMonitorRow | null>(null);
  const [remove, setRemove] = useState<RoomMonitorRow | null>(null);
  const [roomToggle, setRoomToggle] = useState<RoomRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const tour = useAutoTour('rooms', TOUR_STEPS.rooms);

  const reload = () => { monitor.reload(); all.reload(); };
  const assignedIds = useMemo(() => new Set((monitor.data ?? []).map((r) => r.room_id)), [monitor.data]);
  const filtered = (monitor.data ?? []).filter((r) => (!status || r.status === status) && (!q.trim() || r.room_code.toLowerCase().includes(q.trim().toLowerCase())));
  const allFiltered = (all.data ?? []).filter((r) => !rq.trim() || `${r.room_code} ${r.building ?? ''}`.toLowerCase().includes(rq.trim().toLowerCase()));

  const sessionCols: Column<RoomMonitorRow>[] = [
    { key: 'room', header: 'Room', cell: (r) => <span className="font-semibold">{r.room_code}</span> },
    { key: 'cap', header: 'Capacity', className: 'text-right tabular-nums', cell: (r) => r.capacity },
    { key: 'alloc', header: 'Allocated', className: 'text-right tabular-nums', cell: (r) => r.allocated },
    { key: 'avail', header: 'Available', className: 'text-right tabular-nums', cell: (r) => r.available },
    { key: 'status', header: 'Status', cell: (r) => <>{roomStatusBadge(r.status)}{!r.room_active && <span className="ml-1 text-xs text-slate-600">(room off)</span>}{!r.link_active && r.room_active && <span className="ml-1 text-xs text-slate-600">(off for session)</span>}</> },
    {
      key: 'act', header: '', className: 'text-right', cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setCap(r)} aria-label={`Edit capacity of ${r.room_code}`}><Pencil className="h-4 w-4" aria-hidden />Capacity</Button>
          <Button variant="ghost" size="sm" onClick={() => setLinkToggle(r)} aria-label={`${r.link_active ? 'Deactivate' : 'Activate'} ${r.room_code} for this session`}><Power className="h-4 w-4" aria-hidden />{r.link_active ? 'Deactivate' : 'Activate'}</Button>
          <Button variant="ghost" size="sm" onClick={() => setRemove(r)} aria-label={`Remove ${r.room_code} from this session`}><Trash2 className="h-4 w-4" aria-hidden />Remove</Button>
        </div>
      ),
    },
  ];

  const roomCols: Column<RoomRow>[] = [
    { key: 'room', header: 'Room', cell: (r) => <span className="font-semibold">{r.room_code}</span> },
    { key: 'where', header: 'Building / floor', cell: (r) => [r.building, r.floor ? `Floor ${r.floor}` : null].filter(Boolean).join(' · ') || '-' },
    { key: 'links', header: 'Sessions', className: 'text-right tabular-nums', cell: (r) => r.session_links },
    { key: 'alloc', header: 'Active allocations', className: 'text-right tabular-nums', cell: (r) => r.active_allocations },
    { key: 'status', header: 'Status', cell: (r) => (r.is_active ? <Badge tone="green">Active</Badge> : <Badge tone="neutral">Inactive</Badge>) },
    {
      key: 'act', header: '', className: 'text-right', cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setRoomForm({ existing: r })} aria-label={`Edit room ${r.room_code}`}><Pencil className="h-4 w-4" aria-hidden />Edit</Button>
          <Button variant="ghost" size="sm" onClick={() => setRoomToggle(r)} aria-label={`${r.is_active ? 'Deactivate' : 'Activate'} room ${r.room_code}`}><Power className="h-4 w-4" aria-hidden />{r.is_active ? 'Deactivate' : 'Activate'}</Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Rooms" subtitle="Rooms are eligible only when active and assigned to the session. Capacity is the maximum number of invigilators, set per session."
        actions={<Button onClick={() => setRoomForm({})} data-testid="new-room"><Plus className="h-4 w-4" aria-hidden />New room</Button>} />

      <Card className="mb-6" title={selected ? `Rooms in ${formatExamDate(selected.exam_date)} · ${selected.session_label}` : 'Rooms in the selected session'}
        actions={<div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={!selectedId} onClick={() => setImportOpen(true)} data-testid="import-rooms"><Upload className="h-4 w-4" aria-hidden />Import rooms</Button>
          <Button size="sm" disabled={!selectedId} onClick={() => setAssign(true)} data-testid="assign-room"><Plus className="h-4 w-4" aria-hidden />Assign room</Button>
        </div>}>
        {!selectedId ? <EmptyState title="No session selected">Create a session first, then assign rooms to it.</EmptyState> : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              <div className="relative min-w-48 flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
                <Input id="rooms-session-search" name="rooms-session-search" aria-label="Search session rooms" placeholder="Search rooms" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} /></div>
              <Select id="rooms-session-status" name="rooms-session-status" aria-label="Filter session rooms by status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option><option value="available">Available</option><option value="full">Full</option><option value="inactive">Inactive</option></Select>
            </div>
            <ErrorBox error={monitor.error} onRetry={monitor.reload} />
            <DataTable caption="Rooms assigned to the session" columns={sessionCols} rows={filtered} rowKey={(r) => r.session_room_id} loading={monitor.loading}
              empty={<EmptyState title={(monitor.data ?? []).length ? 'No rooms match the filter' : 'No rooms assigned yet'}>Use “Assign room” to make rooms eligible for this session.</EmptyState>} />
          </>
        )}
      </Card>

      <Card title="All rooms">
        <div className="relative mb-3 max-w-sm"><Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
          <Input id="rooms-all-search" name="rooms-all-search" aria-label="Search all rooms" placeholder="Search rooms" className="pl-9" value={rq} onChange={(e) => setRq(e.target.value)} /></div>
        <ErrorBox error={all.error} onRetry={all.reload} />
        <DataTable caption="All rooms" columns={roomCols} rows={allFiltered} rowKey={(r) => r.id} loading={all.loading}
          empty={<EmptyState title="No rooms yet">Create rooms, then assign them to sessions.</EmptyState>} />
      </Card>

      {importOpen && selectedId && selected && (
        <RoomImportWizard sessionId={selectedId} sessionLabel={`${formatExamDate(selected.exam_date)} · ${selected.session_label}`}
          onClose={() => setImportOpen(false)} onChanged={reload} />
      )}
      {cap && <CapacityDialog row={cap} onClose={() => setCap(null)} onDone={reload} />}
      {assign && selectedId && <AssignDialog sessionId={selectedId} rooms={all.data ?? []} assignedIds={assignedIds} onClose={() => setAssign(false)} onDone={reload} />}
      {roomForm && <RoomForm existing={roomForm.existing} onClose={() => setRoomForm(null)} onDone={reload} />}
      {linkToggle && (
        <ConfirmDialog title={`${linkToggle.link_active ? 'Deactivate' : 'Activate'} ${linkToggle.room_code} for this session?`} tone={linkToggle.link_active ? 'danger' : 'primary'}
          confirmLabel={linkToggle.link_active ? 'Deactivate' : 'Activate'} requireReason onClose={() => setLinkToggle(null)}
          onConfirm={async (reason) => { await api.setSessionRoomActive(linkToggle.session_room_id, !linkToggle.link_active, reason, linkToggle.allocated > 0); push('success', 'Updated'); reload(); }}>
          {linkToggle.link_active
            ? <p>No <strong>new</strong> invigilators will be placed in this room for this session.{linkToggle.allocated > 0 && <> The <strong>{linkToggle.allocated}</strong> already allocated stay where they are.</>}</p>
            : <p>The room becomes eligible for allocation in this session again.</p>}
        </ConfirmDialog>
      )}
      {remove && (
        <ConfirmDialog title={`Remove ${remove.room_code} from this session?`} tone="danger" confirmLabel="Remove" requireReason onClose={() => setRemove(null)}
          onConfirm={async (reason) => { await api.removeSessionRoom(remove.session_room_id, reason); push('success', 'Room removed from the session'); reload(); }}>
          <p>This only works if the room has <strong>never</strong> held an allocation in this session. Otherwise deactivate it instead, so history is preserved.</p>
        </ConfirmDialog>
      )}
      {roomToggle && (
        <ConfirmDialog title={`${roomToggle.is_active ? 'Deactivate' : 'Activate'} room ${roomToggle.room_code}?`} tone={roomToggle.is_active ? 'danger' : 'primary'}
          confirmLabel={roomToggle.is_active ? 'Deactivate' : 'Activate'} requireReason onClose={() => setRoomToggle(null)}
          onConfirm={async (reason) => { await api.setRoomActive(roomToggle.id, !roomToggle.is_active, reason, roomToggle.active_allocations > 0); push('success', 'Room updated'); reload(); }}>
          {roomToggle.is_active
            ? <p>The room stops receiving new allocations in <strong>every</strong> session.{roomToggle.active_allocations > 0 && <> Its <strong>{roomToggle.active_allocations}</strong> existing allocations are kept.</>}</p>
            : <p>The room can receive allocations again in sessions where it is assigned and active.</p>}
        </ConfirmDialog>
      )}
      {tour.running && <Tour steps={tour.steps} onDone={tour.finish} onSkip={tour.finish} />}
    </>
  );
}

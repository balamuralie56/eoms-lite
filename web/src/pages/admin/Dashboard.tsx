import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api } from '../../lib/api';
import { useSessions } from '../../context/SessionContext';
import { ErrorBox, useAdminQuery } from '../../lib/adminHooks';
import { Badge, Card, DataTable, EmptyState, Input, PageHeader, Select, Skeleton, StatCard, type Column } from '../../components/ui';
import { formatExamDate, formatIst, formatIstTime, sessionName } from '../../lib/time';
import type { Overview, RoomMonitorRow } from '../../lib/types';

const STATE_TONE = { OPEN: 'green', UPCOMING: 'blue', CLOSED: 'neutral', INACTIVE: 'amber', NONE: 'neutral' } as const;
const STATE_LABEL = { OPEN: 'Check-in open', UPCOMING: 'Upcoming', CLOSED: 'Closed', INACTIVE: 'Inactive', NONE: 'No session' } as const;

export function roomStatusBadge(s: RoomMonitorRow['status']) {
  return s === 'full' ? <Badge tone="red">Full</Badge> : s === 'inactive' ? <Badge tone="neutral">Inactive</Badge> : <Badge tone="green">Available</Badge>;
}

export default function Dashboard() {
  const { selectedId, loading: sessionsLoading, sessions } = useSessions();
  const ov = useAdminQuery(() => api.overview(selectedId), [selectedId], { pollMs: 8000, enabled: !sessionsLoading });
  const sessionId = ov.data?.session?.id ?? null;
  const rooms = useAdminQuery(() => (sessionId ? api.roomMonitor(sessionId) : Promise.resolve([] as RoomMonitorRow[])), [sessionId], { pollMs: 8000, enabled: Boolean(sessionId) });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  const filtered = useMemo(() => (rooms.data ?? []).filter((r) =>
    (!status || r.status === status) && (!q.trim() || `${r.room_code} ${r.building ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))), [rooms.data, q, status]);

  const o: Overview | undefined = ov.data;
  const c = o?.counts;

  const roomCols: Column<RoomMonitorRow>[] = [
    { key: 'room', header: 'Room', cell: (r) => <span className="font-semibold">{r.room_code}</span> },
    { key: 'where', header: 'Building / floor', cell: (r) => [r.building, r.floor ? `Floor ${r.floor}` : null].filter(Boolean).join(' · ') || '-' },
    { key: 'cap', header: 'Capacity', className: 'text-right tabular-nums', cell: (r) => r.capacity },
    { key: 'alloc', header: 'Allocated', className: 'text-right tabular-nums', cell: (r) => r.allocated },
    { key: 'avail', header: 'Available', className: 'text-right tabular-nums', cell: (r) => r.available },
    { key: 'status', header: 'Status', cell: (r) => roomStatusBadge(r.status) },
  ];

  if (!sessionsLoading && sessions.length === 0) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <EmptyState title="No examination sessions yet">Start by <Link className="font-semibold text-blue-700 underline" to="/admin/sessions">creating a session</Link>, then add rooms and import the schedule.</EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={o?.session ? (
          <span data-testid="dashboard-session">
            {formatExamDate(o.session.exam_date)} · {sessionName(o.session.session)} · opens {formatIstTime(o.session.checkin_opens_at)}, closes {formatIstTime(o.session.checkin_closes_at)} IST
          </span>) : 'Live operational overview'}
        actions={o && <Badge tone={STATE_TONE[o.state]}>{STATE_LABEL[o.state]}</Badge>}
      />
      <ErrorBox error={ov.error} onRetry={ov.reload} />
      {!o && !ov.error && <Skeleton rows={3} />}
      {o && !o.session && <EmptyState title="No session selected">Choose a working session from the menu.</EmptyState>}
      {c && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7" data-testid="stat-cards">
            <StatCard label="Scheduled" value={c.scheduled} />
            <StatCard label="Allocated" value={c.allocated} tone="green" />
            <StatCard label="Pending" value={c.pending} tone={c.pending > 0 ? 'amber' : undefined} hint="Scheduled, not allocated" />
            <StatCard label="Flagged" value={c.flagged} tone={c.flagged > 0 ? 'red' : undefined} />
            <StatCard label="Active rooms" value={c.active_rooms} />
            <StatCard label="Full rooms" value={c.full_rooms} />
            <StatCard label="Free slots" value={c.available_slots} hint={`of ${c.total_slots} total`} tone={c.available_slots === 0 ? 'red' : undefined} />
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-5">
            <Card className="xl:col-span-3" title="Room monitor" actions={<span className="text-xs text-slate-600">Refreshes every 8 s</span>}>
              <div className="mb-3 flex flex-wrap gap-2">
                <div className="relative min-w-48 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
                  <Input aria-label="Search rooms" placeholder="Search rooms" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
                  <option value="">All statuses</option>
                  <option value="available">Available</option>
                  <option value="full">Full</option>
                  <option value="inactive">Inactive</option>
                </Select>
              </div>
              <ErrorBox error={rooms.error} onRetry={rooms.reload} />
              <DataTable caption="Room allocation monitor" columns={roomCols} rows={filtered} rowKey={(r) => r.session_room_id} loading={rooms.loading}
                empty={<EmptyState title={(rooms.data ?? []).length ? 'No rooms match the filter' : 'No rooms assigned to this session'}><Link className="font-semibold text-blue-700 underline" to="/admin/rooms">Assign rooms</Link></EmptyState>} />
            </Card>

            <Card className="xl:col-span-2" title="Recent activity">
              <DataTable caption="Recent allocations" rows={o?.recent} rowKey={(r) => r.allocation_id}
                empty={<EmptyState title="No allocations yet">Activity appears here as employees check in.</EmptyState>}
                columns={[
                  { key: 'who', header: 'Employee', cell: (r) => <><span className="font-semibold">{r.employee_name ?? r.employee_id}</span><span className="block text-xs text-slate-600">{r.employee_id}</span></> },
                  { key: 'room', header: 'Room', cell: (r) => <>{r.room_code}{r.released_at && <Badge tone="amber">Released</Badge>}</> },
                  { key: 'at', header: 'Time', cell: (r) => <span className="whitespace-nowrap text-xs">{formatIst(r.allocated_at)}</span> },
                ]} />
            </Card>
          </div>
        </>
      )}
    </>
  );
}

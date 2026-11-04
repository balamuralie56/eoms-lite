import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import {
  BarChart3, CalendarClock, ClipboardList, DoorOpen, FileSpreadsheet, HelpCircle, LayoutDashboard, ListChecks, LogOut, Menu, Settings as Cog, ShieldCheck, X,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useConfig } from '../../context/ConfigContext';
import { SessionProvider, useSessions } from '../../context/SessionContext';
import { Button, Select, Spinner, cx } from '../ui';
import { formatExamDate } from '../../lib/time';

const NAV = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/sessions', label: 'Sessions', icon: CalendarClock },
  { to: '/admin/rooms', label: 'Rooms', icon: DoorOpen },
  { to: '/admin/schedule', label: 'Schedule', icon: FileSpreadsheet },
  { to: '/admin/allocations', label: 'Allocations', icon: ListChecks },
  { to: '/admin/verification', label: 'Verification', icon: ShieldCheck },
  { to: '/admin/audit', label: 'Audit log', icon: ClipboardList },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3 },
  { to: '/admin/settings', label: 'Settings', icon: Cog },
  { to: '/admin/help', label: 'Help', icon: HelpCircle },
];

function SessionPicker() {
  const { sessions, selectedId, select } = useSessions();
  if (sessions.length === 0) return <p className="text-xs text-slate-700">No sessions yet</p>;
  return (
    <div data-tour="session-picker">
      <label htmlFor="session-picker" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-700">Working session</label>
      <Select id="session-picker" value={selectedId ?? ''} onChange={(e) => select(e.target.value || null)} className="!py-1.5 text-sm">
        {sessions.map((s) => <option key={s.id} value={s.id}>{formatExamDate(s.exam_date)} · {s.session_label}{s.is_active ? '' : ' (inactive)'}</option>)}
      </Select>
    </div>
  );
}

function Shell() {
  const { email, signOut } = useAuth();
  const { config } = useConfig();
  const [open, setOpen] = useState(false);
  const nav = (
    <nav aria-label="Admin" data-tour="nav-list" className="space-y-1">
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
          className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-blue-700 text-white' : 'text-slate-800 hover:bg-black/5')}>
          <n.icon className="h-4 w-4" aria-hidden />{n.label}
        </NavLink>
      ))}
    </nav>
  );
  const side = (
    <div className="flex h-full flex-col gap-5 p-4">
      <Link to="/admin" className="flex items-center gap-2">
        {config.logo_data_url
          ? <img src={config.logo_data_url} alt="" className="h-9 w-9 rounded bg-white object-contain p-0.5" />
          : <ShieldCheck className="h-8 w-8 text-blue-700" aria-hidden />}
        <span className="text-sm font-bold leading-tight text-slate-900">{config.exam_cell_name}<span className="block text-xs font-normal text-slate-700">{config.institution_name}</span></span>
      </Link>
      <SessionPicker />
      {nav}
      <div className="mt-auto space-y-2 border-t border-black/10 pt-3">
        <p className="truncate text-xs text-slate-700" title={email ?? ''} data-testid="admin-identity">Signed in as <span className="font-semibold text-slate-900">{email}</span></p>
        <Button variant="secondary" size="sm" className="w-full" onClick={() => void signOut()}><LogOut className="h-4 w-4" aria-hidden />Sign out</Button>
      </div>
    </div>
  );
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
      <aside className="hidden bg-yellow-500 lg:block">{side}</aside>
      <header className="sticky top-0 z-30 flex items-center justify-between bg-yellow-500 px-4 py-3 lg:hidden">
        <span className="text-sm font-bold text-slate-900">{config.exam_cell_name}</span>
        <button type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)} className="rounded p-1 text-slate-900"><Menu className="h-6 w-6" aria-hidden /></button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-yellow-500">
            <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} className="absolute right-3 top-3 rounded p-1 text-slate-900"><X className="h-5 w-5" aria-hidden /></button>
            {side}
          </div>
        </div>
      )}
      <main className="min-w-0 px-4 py-6 sm:px-8"><div className="mx-auto max-w-7xl"><Outlet /></div></main>
    </div>
  );
}

/**
 * Client-side route guard. It is a CONVENIENCE: the database (RLS + is_admin() inside every RPC) is what actually
 * protects data. A user who bypasses this component still gets "not authorized" from every call.
 */
export default function AdminGate() {
  const { state, email, signOut } = useAuth();
  const loc = useLocation();
  if (state === 'loading') return <div className="grid min-h-screen place-items-center"><Spinner label="Checking your session" /></div>;
  if (state === 'signedOut') return <Navigate to="/admin/login" replace state={{ from: loc.pathname }} />;
  if (state === 'notAdmin') {
    return (
      <main className="mx-auto max-w-md px-4 py-20 text-center">
        <ShieldCheck className="mx-auto h-10 w-10 text-amber-600" aria-hidden />
        <h1 className="mt-3 text-2xl font-bold">No administrator access</h1>
        <p className="mt-2 text-slate-700">{email} is signed in but is not an active administrator. Ask an existing administrator to enable your account.</p>
        <Button className="mt-6" variant="secondary" onClick={() => void signOut()}>Sign out</Button>
      </main>
    );
  }
  return <SessionProvider><Shell /></SessionProvider>;
}

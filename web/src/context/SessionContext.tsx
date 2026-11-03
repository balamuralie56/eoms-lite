import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';
import { useQuery } from '../lib/hooks';
import type { SessionSummary } from '../lib/types';

interface Ctx {
  sessions: SessionSummary[];
  loading: boolean;
  selectedId: string | null;
  selected: SessionSummary | undefined;
  select: (id: string | null) => void;
  refresh: () => Promise<void>;
}
const SessionCtx = createContext<Ctx>({ sessions: [], loading: true, selectedId: null, selected: undefined, select: () => undefined, refresh: async () => undefined });

const KEY = 'eoms.selectedSession';
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const write = (v: string | null) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* storage may be blocked: it is only a convenience */ } };

/** Open now, else the NEXT session to open, else the most recently closed one, else the first listed. */
export function defaultPick(list: SessionSummary[]): string | null {
  const open = list.find((s) => s.state === 'OPEN');
  if (open) return open.id;
  const next = list.filter((s) => s.state === 'UPCOMING').sort((a, b) => a.checkin_opens_at.localeCompare(b.checkin_opens_at))[0];
  if (next) return next.id;
  const last = list.filter((s) => s.state === 'CLOSED').sort((a, b) => b.checkin_closes_at.localeCompare(a.checkin_closes_at))[0];
  return (last ?? list.find((s) => s.is_active) ?? list[0])?.id ?? null;
}

/** The session the admin is working on. Pages share it; the choice is remembered per browser as a convenience only. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { handleError } = useAuth();
  const q = useQuery(() => api.listSessions(), []);
  const [chosen, setChosen] = useState<string | null>(read);

  useEffect(() => { if (q.error) handleError(q.error); }, [q.error, handleError]);

  const sessions = useMemo(() => q.data ?? [], [q.data]);
  // derived, not stored: the explicit choice if it still exists, otherwise the sensible default
  const selectedId = chosen && sessions.some((s) => s.id === chosen) ? chosen : defaultPick(sessions);
  const select = useCallback((id: string | null) => { setChosen(id); write(id); }, []);
  const reload = q.reload;
  const refresh = useCallback(async () => { reload(); }, [reload]);
  const selected = sessions.find((s) => s.id === selectedId);

  const value = useMemo(() => ({ sessions, loading: q.loading && !q.data, selectedId, selected, select, refresh }),
    [sessions, q.loading, q.data, selectedId, selected, select, refresh]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

export const useSessions = () => useContext(SessionCtx);

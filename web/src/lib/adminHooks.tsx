import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useQuery, type QueryState } from './hooks';
import { ApiError } from './rpc';
import { Alert, Button, useToast } from '../components/ui';

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.isNetwork ? 'Could not reach the server. Check your connection and try again.' : e.message;
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/** useQuery that also reports auth problems (expired session / lost admin rights) to the AuthContext. */
export function useAdminQuery<T>(fn: () => Promise<T>, deps: unknown[], opts: { pollMs?: number; enabled?: boolean } = {}): QueryState<T> {
  const { handleError } = useAuth();
  const q = useQuery(fn, deps, opts);
  useEffect(() => { if (q.error) handleError(q.error); }, [q.error, handleError]);
  return q;
}

export function ErrorBox({ error, onRetry }: { error: Error | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Alert tone="error" title="Could not load this data">
      <p>{errText(error)}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>Try again</Button>}
    </Alert>
  );
}

/** Runs an admin action: success toast, error toast, auth errors forwarded. Returns true on success. */
export function useAction() {
  const { push } = useToast();
  const { handleError } = useAuth();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(true);
    try { await fn(); push('success', success); return true; }
    catch (e) { handleError(e); push('error', errText(e)); return false; }
    finally { setBusy(false); }
  }, [push, handleError]);
  return { run, busy };
}

/** Admin date input (YYYY-MM-DD, interpreted in Asia/Kolkata) -> ISO instant for report/audit date filters. */
export function istDayStart(ymd: string): string { return `${ymd}T00:00:00+05:30`; }
export function istNextDayStart(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 10)}T00:00:00+05:30`;
}

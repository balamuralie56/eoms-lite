import { useEffect, useRef, useState } from 'react';
import { ApiError } from './rpc';

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

interface Settled<T> { key: string; data?: T; error?: Error }

/**
 * Minimal data hook. The request is identified by a key built from `deps` plus a reload counter; `loading` is DERIVED
 * (the latest settled result does not belong to the current key yet), so no state is set synchronously inside an effect.
 * Keeps the previous data visible while a new request is in flight, ignores out-of-order responses, optionally polls
 * (silently, and not while the tab is hidden).
 */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[], opts: { pollMs?: number; enabled?: boolean } = {}): QueryState<T> {
  const enabled = opts.enabled ?? true;
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T>>();
  const key = `${JSON.stringify(deps)}#${tick}`;
  const fnRef = useRef(fn);
  const keyRef = useRef(key);

  useEffect(() => { fnRef.current = fn; keyRef.current = key; });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fnRef.current().then(
      (data) => { if (alive) setSettled({ key, data }); },
      (e: unknown) => { if (alive) setSettled({ key, error: e instanceof Error ? e : new Error(String(e)) }); },
    );
    return () => { alive = false; };
  }, [key, enabled]);

  useEffect(() => {
    if (!opts.pollMs || !enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const k = keyRef.current;
      fnRef.current().then(
        (data) => { if (k === keyRef.current) setSettled({ key: k, data }); },
        (e: unknown) => {
          // A failed background refresh keeps the last good data on screen, EXCEPT for authentication/authorization
          // failures (expired token, revoked admin): those must surface so the session can be ended.
          if (e instanceof ApiError && (e.isUnauthorized || e.isForbidden) && k === keyRef.current) {
            setSettled((prev) => ({ key: k, data: prev?.data, error: e }));
          }
        },
      );
    }, opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs, enabled]);

  const current = settled?.key === key ? settled : undefined;
  return {
    data: settled?.data,
    error: current?.error,
    loading: enabled && current === undefined,
    reload: () => setTick((t) => t + 1),
  };
}

export function useDebounced<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

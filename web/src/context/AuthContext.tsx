import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getSupabase, isConfigured } from '../lib/supabase';
import { api } from '../lib/api';
import { ApiError } from '../lib/rpc';

/**
 * loading:   checking the stored session
 * signedOut: no valid session
 * notAdmin:  signed in, but NOT an active admin in the database (the database, not this flag, is authoritative)
 * admin:     signed in AND the database confirmed is_admin()
 */
export type AuthState = 'loading' | 'signedOut' | 'notAdmin' | 'admin';

interface Ctx {
  state: AuthState;
  email: string | null;
  notice: string | null;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  /** Pages call this with any error: an expired session signs out, a forbidden answer flips to notAdmin. */
  handleError: (e: unknown) => void;
  clearNotice: () => void;
}

const AuthContext = createContext<Ctx>({
  state: 'loading', email: null, notice: null,
  signIn: async () => null, signOut: async () => undefined, handleError: () => undefined, clearNotice: () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => (isConfigured() ? 'loading' : 'signedOut'));
  const [email, setEmail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Several evaluations can overlap (the sign-in call, token-refresh events). Only the NEWEST may change the state, so a
  // late answer from an older one cannot overwrite it. The "session expired" notice is the exception: it is sticky, set by
  // whichever evaluation sees the rejection, and cleared only by an explicit user action (signing in or out).
  const latest = useRef(0);

  const evaluate = useCallback(async () => {
    const mine = ++latest.current;
    const current = () => mine === latest.current;
    const { data } = await getSupabase().auth.getSession();
    if (!data.session) { if (current()) { setEmail(null); setState('signedOut'); } return; }
    if (current()) setEmail(data.session.user.email ?? null);
    try {
      const ok = await api.isAdmin();
      if (current()) setState(ok ? 'admin' : 'notAdmin');
    } catch (e) {
      if (e instanceof ApiError && e.isUnauthorized) {
        await getSupabase().auth.signOut();
        setNotice('Your session has expired. Please sign in again.');
        if (current()) { setEmail(null); setState('signedOut'); }
        return;
      }
      // not an expiry: only conclude "not an administrator" if a session still exists (a sign-out may have raced us)
      const again = await getSupabase().auth.getSession();
      if (!current()) return;
      if (!again.data.session) { setEmail(null); setState('signedOut'); } else setState('notAdmin');
    }
  }, []);

  useEffect(() => {
    if (!isConfigured()) return;
    // supabase-js calls this immediately with INITIAL_SESSION. Its documentation warns against awaiting other
    // supabase calls inside the callback (deadlock), so the evaluation is deferred to the next tick.
    const { data: sub } = getSupabase().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') { setEmail(null); setState('signedOut'); return; }
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') setTimeout(() => { void evaluate(); }, 0);
    });
    return () => sub.subscription.unsubscribe();
  }, [evaluate]);

  const signIn = useCallback(async (e: string, p: string) => {
    setNotice(null);        // clear BEFORE signing in: a notice raised while the new session is being validated must survive
    const { error } = await getSupabase().auth.signInWithPassword({ email: e.trim(), password: p });
    if (error) return error.status === 400 || /invalid/i.test(error.message) ? 'Incorrect email or password.' : 'Could not sign in. Please try again.';
    await evaluate();
    return null;
  }, [evaluate]);

  const signOut = useCallback(async () => {
    setNotice(null);
    await getSupabase().auth.signOut();
    setEmail(null);
    setState('signedOut');
  }, []);

  const handleError = useCallback((e: unknown) => {
    if (!(e instanceof ApiError)) return;
    if (e.isUnauthorized) {
      void getSupabase().auth.signOut().finally(() => { setNotice('Your session has expired. Please sign in again.'); setState('signedOut'); });
    } else if (e.isForbidden) {
      setState('notAdmin');
    }
  }, []);

  const value = useMemo(() => ({ state, email, notice, signIn, signOut, handleError, clearNotice: () => setNotice(null) }),
    [state, email, notice, signIn, signOut, handleError]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LogIn, ShieldCheck } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useConfig } from '../../context/ConfigContext';
import { Alert, Button, Field, Input, Spinner } from '../../components/ui';

export default function Login() {
  const { state, notice, signIn } = useAuth();
  const { config } = useConfig();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state === 'loading') return <div className="grid min-h-screen place-items-center"><Spinner label="Checking your session" /></div>;
  if (state === 'admin' || state === 'notAdmin') {
    const to = (loc.state as { from?: string } | null)?.from ?? '/admin';
    return <Navigate to={to} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const err = await signIn(email, password);
    if (err) setError(err);
    setBusy(false);
  };

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          {config.logo_data_url
            ? <img src={config.logo_data_url} alt="" className="mx-auto h-14 w-14 object-contain" />
            : <ShieldCheck className="mx-auto h-12 w-12 text-blue-700" aria-hidden />}
          <h1 className="mt-3 text-2xl font-bold text-slate-900">Administrator sign in</h1>
          <p className="text-sm text-slate-600">{config.exam_cell_name}</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          {notice && <Alert tone="warning">{notice}</Alert>}
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" className="w-full" loading={busy}><LogIn className="h-4 w-4" aria-hidden />Sign in</Button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-600">Accounts are created by an existing administrator. There is no self-registration.</p>
      </div>
    </main>
  );
}

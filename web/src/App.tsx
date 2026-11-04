import { Navigate, Route, Routes } from 'react-router-dom';
import { isConfigured } from './lib/supabase';
import CheckIn from './pages/public/CheckIn';
import AdminGate from './components/layout/AdminGate';
import Login from './pages/admin/Login';
import Dashboard from './pages/admin/Dashboard';
import Sessions from './pages/admin/Sessions';
import Rooms from './pages/admin/Rooms';
import Schedule from './pages/admin/Schedule';
import Allocations from './pages/admin/Allocations';
import Verification from './pages/admin/Verification';
import Audit from './pages/admin/Audit';
import Reports from './pages/admin/Reports';
import Settings from './pages/admin/Settings';
import Help from './pages/admin/Help';

function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-slate-600">The page you are looking for does not exist.</p>
      <a href="/" className="mt-6 inline-block font-semibold text-blue-700 underline">Go to check-in</a>
    </main>
  );
}

function Misconfigured() {
  return (
    <main className="mx-auto max-w-lg px-4 py-20">
      <h1 className="text-2xl font-bold">Not configured</h1>
      <p className="mt-2 text-slate-700">This build has no backend connection. Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> and rebuild. See the deployment guide.</p>
    </main>
  );
}

export default function App() {
  if (!isConfigured()) return <Misconfigured />;
  return (
    <Routes>
      <Route path="/" element={<CheckIn />} />
      <Route path="/admin/login" element={<Login />} />
      <Route path="/admin" element={<AdminGate />}>
        <Route index element={<Dashboard />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="rooms" element={<Rooms />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="allocations" element={<Allocations />} />
        <Route path="verification" element={<Verification />} />
        <Route path="audit" element={<Audit />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
        <Route path="help" element={<Help />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

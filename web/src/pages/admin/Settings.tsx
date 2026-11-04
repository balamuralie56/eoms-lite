import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Download, HelpCircle, QrCode, Save, ShieldAlert, Trash2, Wrench } from 'lucide-react';
import { api } from '../../lib/api';
import { useConfig } from '../../context/ConfigContext';
import { useAuth } from '../../context/AuthContext';
import { getSupabase } from '../../lib/supabase';
import { ErrorBox, errText, useAdminQuery } from '../../lib/adminHooks';
import { Alert, Button, Card, ConfirmDialog, Field, Input, PageHeader, Skeleton, Spinner, Textarea, useToast } from '../../components/ui';
import type { AdminSettings } from '../../lib/types';
import { downloadBlob } from '../../lib/csv';
import { buildZip, type ZipEntry } from '../../lib/zip';
import { Tour } from '../../components/tour/Tour';
import { useAutoTour } from '../../components/tour/useAutoTour';
import { TOUR_STEPS } from '../../lib/tourSteps';
import { resetAllTours } from '../../lib/tourStore';

const MAX_LOGO_BYTES = 150 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function Branding() {
  const q = useAdminQuery(() => api.getSettings(), []);
  return (
    <Card title="Branding and display">
      <ErrorBox error={q.error} onRetry={q.reload} />
      {!q.data ? (q.loading ? <Skeleton rows={5} /> : null) : <BrandingForm key={q.data.updated_at} data={q.data} onSaved={q.reload} />}
    </Card>
  );
}

function BrandingForm({ data: d, onSaved }: { data: AdminSettings; onSaved: () => void }) {
  const { setConfig } = useConfig();
  const { push } = useToast();
  const [f, setF] = useState({ institution: d.institution_name, cell: d.exam_cell_name, title: d.app_title, contact: d.contact_instructions, support: d.support_info ?? '', perPage: d.default_items_per_page });
  const [logo, setLogo] = useState<string | null>(d.logo_data_url);
  const [logoChanged, setLogoChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onLogo = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (!LOGO_TYPES.includes(file.type)) { setError('The logo must be a PNG, JPEG or WebP image (SVG is not allowed).'); return; }
    if (file.size > MAX_LOGO_BYTES) { setError(`The logo is larger than ${MAX_LOGO_BYTES / 1024} KB. Use a smaller image.`); return; }
    const r = new FileReader();
    r.onload = () => { setLogo(String(r.result)); setLogoChanged(true); };
    r.readAsDataURL(file);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const res = await api.updateSettings({
        institution: f.institution, cell: f.cell, title: f.title, contact: f.contact, support: f.support, perPage: f.perPage,
        ...(logoChanged ? (logo ? { logo } : { clearLogo: true }) : {}),
      });
      setConfig({ institution_name: res.institution_name, exam_cell_name: res.exam_cell_name, app_title: res.app_title, logo_data_url: res.logo_data_url,
        contact_instructions: res.contact_instructions, support_info: res.support_info });
      push('success', 'Settings saved'); onSaved();
    } catch (err) { setError(errText(err)); }
    finally { setBusy(false); }
  };

  return (
        <form onSubmit={submit} className="space-y-4" aria-label="Branding settings">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Institution name" htmlFor="b-inst"><Input id="b-inst" required maxLength={120} value={f.institution} onChange={(e) => setF({ ...f, institution: e.target.value })} /></Field>
            <Field label="Examination cell name" htmlFor="b-cell"><Input id="b-cell" required maxLength={120} value={f.cell} onChange={(e) => setF({ ...f, cell: e.target.value })} /></Field>
            <Field label="Application title" htmlFor="b-title" hint="Shown on the check-in page and browser tab."><Input id="b-title" required maxLength={80} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Default rows per page" htmlFor="b-per" hint="Between 10 and 100."><Input id="b-per" type="number" min={10} max={100} value={f.perPage} onChange={(e) => setF({ ...f, perPage: Number(e.target.value) })} /></Field>
          </div>
          <Field label="Contact instructions" htmlFor="b-contact" hint="Shown to employees when something needs the examination cell, for example: “Please contact Room 12, Admin Block.”"><Textarea id="b-contact" rows={2} maxLength={500} value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></Field>
          <Field label="Support information" htmlFor="b-support" hint="Optional line shown at the bottom of the check-in page (phone or email)."><Textarea id="b-support" rows={2} maxLength={500} value={f.support} onChange={(e) => setF({ ...f, support: e.target.value })} /></Field>
          <div>
            <p className="text-sm font-medium text-slate-800">Logo</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              {logo ? <img src={logo} alt="Current logo" className="h-16 w-16 rounded border border-slate-300 bg-white object-contain p-1" /> : <span className="text-sm text-slate-600">No logo set</span>}
              <label className="cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-within:outline-2 focus-within:outline-blue-700">
                Choose image<input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={onLogo} data-testid="logo-file" />
              </label>
              {logo && <Button variant="ghost" size="sm" onClick={() => { setLogo(null); setLogoChanged(true); }}><Trash2 className="h-4 w-4" aria-hidden />Remove</Button>}
            </div>
            <p className="mt-1 text-xs text-slate-600">PNG, JPEG or WebP, up to 150 KB. It is stored in the database and shown on the check-in page and slips.</p>
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          <Button type="submit" loading={busy}><Save className="h-4 w-4" aria-hidden />Save settings</Button>
        </form>
  );
}

function QrTool() {
  const [url, setUrl] = useState(window.location.origin);
  const [verified, setVerified] = useState(false);
  const [qr, setQr] = useState<{ url: string; png?: string; err?: string }>();
  const https = /^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(url);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url);

  useEffect(() => {
    if (!https && !local) return;
    let alive = true;
    QRCode.toDataURL(url, { width: 2048, margin: 4, errorCorrectionLevel: 'H' }).then(
      (png) => { if (alive) setQr({ url, png }); },
      () => { if (alive) setQr({ url, err: 'Could not generate the QR code.' }); },
    );
    return () => { alive = false; };
  }, [url, https, local]);
  // derived: a result only counts while it belongs to the address currently typed
  const current = qr && qr.url === url && (https || local) ? qr : undefined;
  const png = current?.png ?? null;
  const err = current?.err ?? null;

  const download = () => {
    if (!png) return;
    // decode the data URL directly: fetch('data:...') is (rightly) blocked by the site's connect-src policy
    const bin = atob(png.slice(png.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    downloadBlob(new Blob([bytes], { type: 'image/png' }), 'eoms-checkin-qr.png');
  };

  return (
    <Card title="Permanent QR code">
      <p className="mb-3 text-sm text-slate-700">The QR code contains <strong>only this web address</strong>: no employee, session, date or token. It never changes when sessions change, so you can print it once.</p>
      <Field label="Public check-in address" htmlFor="qr-url" hint="Must be the final public https:// address of this site.">
        <Input id="qr-url" value={url} onChange={(e) => { setUrl(e.target.value.trim()); setVerified(false); }} inputMode="url" />
      </Field>
      {!https && !local && url && <Alert tone="error" className="mt-3">The address must start with https://.</Alert>}
      {local && <Alert tone="warning" className="mt-3">This is a local address. You can preview the code, but the download is disabled until you enter the real https:// domain.</Alert>}
      {err && <Alert tone="error" className="mt-3">{err}</Alert>}
      {png && <div className="mt-3 flex justify-center"><img src={png} alt="QR code preview" className="h-56 w-56 rounded border border-slate-300" /></div>}
      <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 h-4 w-4" checked={verified} disabled={!https} onChange={(e) => setVerified(e.target.checked)} data-testid="qr-verified" />
        <span>I opened this address on a phone over HTTPS and it shows the check-in page (and has the correct certificate).</span></label>
      <Button className="mt-3" onClick={download} disabled={!png || !https || !verified} data-testid="qr-download"><Download className="h-4 w-4" aria-hidden /><QrCode className="h-4 w-4" aria-hidden />Download high-resolution PNG</Button>
    </Card>
  );
}

function Operations() {
  const { push } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);
  const [ipHash, setIpHash] = useState<string | null>(null);
  const [hdrErr, setHdrErr] = useState<string | null>(null);
  const s = useAdminQuery(() => api.getSettings(), []);
  const ret = s.data?.retention ?? {};
  return (
    <Card title="Maintenance and diagnostics">
      <div className="space-y-5">
        <div>
          <p className="text-sm text-slate-700">Removes expired throttle records and abandoned import staging data. <strong>The audit log is never deleted.</strong></p>
          <p className="mt-1 text-xs text-slate-600">Policy: throttle records after {ret.retention_attempts_hours ?? '…'} h · unfinished imports after {ret.retention_staging_days ?? '…'} days · staged rows of finished imports after {ret.retention_committed_rows_days ?? '…'} days.</p>
          <Button variant="secondary" className="mt-2" onClick={() => setConfirm(true)} data-testid="run-maintenance"><Wrench className="h-4 w-4" aria-hidden />Run maintenance now</Button>
        </div>
        <div>
          <p className="text-sm text-slate-700">Shows the request headers the platform passes to the database. Use it once after deployment to confirm which header carries the real client IP (needed by the abuse throttle). Credentials are never shown.</p>
          <Button variant="secondary" className="mt-2" onClick={async () => { setHdrErr(null); try { const r = await api.debugHeaders(); setHeaders(r.headers); setIpHash(r.client_ip_hash_used); } catch (e) { setHdrErr(errText(e)); } }}>Inspect request headers</Button>
          {hdrErr && <Alert tone="error" className="mt-2">{hdrErr}</Alert>}
          {headers && (
            <div className="mt-2">
              <p className="text-xs text-slate-700">Client IP used by the throttle: {ipHash ? 'a header was found (hash stored, never the IP)' : <strong>none found: the throttle is not active for these requests</strong>}</p>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100" data-testid="headers-json">{JSON.stringify(headers, null, 2)}</pre>
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <ConfirmDialog title="Run maintenance?" confirmLabel="Run maintenance" onClose={() => setConfirm(false)}
          onConfirm={async () => { const r = await api.runMaintenance(); push('success', `Removed ${r.check_attempts_deleted} throttle records; cancelled ${r.abandoned_batches_cancelled} abandoned imports; purged ${r.old_import_rows_deleted} old staged rows`); }}>
          <p>This is safe to run at any time and is recorded in the audit log.</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

const COUNT_LABELS: Record<string, string> = {
  sessions: 'examination sessions', rooms: 'rooms', session_rooms: 'room-session assignments', schedule: 'schedule entries',
  allocations: 'allocations', flags: 'verification flags', authorizations: 'late/re-entry authorizations',
  import_batches: 'import batches', import_rows: 'staged import rows', check_attempts: 'throttle records', audit_log: 'audit log entries',
};

function describeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${COUNT_LABELS[k] ?? k}`);
  return parts.length ? parts.join(', ') : 'nothing — the system is already empty';
}

function DangerZone() {
  const { push } = useToast();
  const { email } = useAuth();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(false);
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');

  const startReset = async () => {
    setOpen(true); setCounts(null); setPassword(''); setTyped(''); setLoadingCounts(true);
    try {
      const r = await api.resetAllData(false);
      setCounts(r.would_delete ?? null);
    } finally { setLoadingCounts(false); }
  };

  const confirm = async () => {
    if (!email) throw new Error('No signed-in admin email was found. Please sign out and in again.');
    const { error } = await getSupabase().auth.signInWithPassword({ email, password });
    if (error) throw new Error('Incorrect password.');

    const exported = await api.exportAllData();
    const { exported_at, exported_by, ...tables } = exported;
    const files: ZipEntry[] = Object.entries(tables).map(([k, v]) => ({
      name: `${k}.json`, data: new TextEncoder().encode(JSON.stringify(v, null, 2)),
    }));
    files.push({
      name: 'README.txt',
      data: new TextEncoder().encode(
        `EOMS Lite — full data backup\nExported at: ${exported_at}\nExported by admin: ${exported_by}\n\n`
        + 'This backup was taken immediately before a full data reset. Each .json file is one database table '
        + '(sessions, rooms, schedule, allocations, verification flags, audit log, and so on). Keep it somewhere safe.\n',
      ),
    });
    downloadBlob(buildZip(files), `eoms-backup-${new Date().toISOString().slice(0, 10)}.zip`);

    const res = await api.resetAllData(true);
    push('success', `Backup downloaded. Reset complete — removed ${describeCounts(res.deleted ?? {})}.`);
  };

  return (
    <Card title="Danger zone">
      <p className="text-sm text-slate-700">
        Downloads a full backup — every session, room, schedule entry, allocation, verification flag and audit-log
        entry — as a zip file to this computer, then permanently deletes all of it so the system is ready to run
        clean for the next exam period. <strong>Admin logins and branding/settings are kept</strong>, so you can log
        in again right away.
      </p>
      <Button variant="danger" className="mt-2" onClick={startReset} data-testid="open-data-reset">
        <ShieldAlert className="h-4 w-4" aria-hidden />Backup &amp; reset all data
      </Button>
      {open && (
        <ConfirmDialog title="Download backup and reset all data?" tone="danger" confirmLabel="Download backup &amp; reset"
          onClose={() => setOpen(false)} confirmDisabled={loadingCounts || !password || typed.trim().toUpperCase() !== 'RESET'}
          onConfirm={confirm}
          extra={
            <div className="space-y-3">
              {loadingCounts
                ? <Spinner label="Checking current data" />
                : counts && (
                  <Alert tone="warning">
                    This will permanently delete: <strong>{describeCounts(counts)}</strong>.
                  </Alert>
                )}
              <Field label="Your password" htmlFor="reset-pw" hint="Confirms it's really you, not just an unlocked browser.">
                <Input id="reset-pw" type="password" autoComplete="current-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} data-testid="reset-password" />
              </Field>
              <Field label='Type RESET to confirm' htmlFor="reset-typed">
                <Input id="reset-typed" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="reset-typed" />
              </Field>
            </div>
          }>
          <p>
            The backup zip downloads first. Once it finishes, every session, room, schedule entry, allocation,
            flag and audit-log entry is permanently deleted from the live database. <strong>This cannot be undone</strong> —
            keep the downloaded zip somewhere safe.
          </p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

export default function Settings() {
  const { push } = useToast();
  const tour = useAutoTour('settings', TOUR_STEPS.settings);

  const replayGuide = () => {
    resetAllTours();
    tour.replay();
    push('success', 'Guide reset — it will show again as you open each admin page.');
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Branding shown to employees, the permanent QR code, and housekeeping."
        actions={<Button variant="secondary" size="sm" onClick={replayGuide} data-testid="replay-guide"><HelpCircle className="h-4 w-4" aria-hidden />Replay guide</Button>} />
      <div className="space-y-5">
        <Branding />
        <QrTool />
        <Operations />
        <DangerZone />
      </div>
      {tour.running && <Tour steps={tour.steps} onDone={tour.finish} onSkip={tour.finish} />}
    </>
  );
}

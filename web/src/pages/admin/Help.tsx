import { useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { PageHeader, Card, EmptyState, Input } from '../../components/ui';

interface HelpSection { id: string; title: string; keywords: string; body: ReactNode }

const SECTIONS: HelpSection[] = [
  {
    id: 'sessions', title: '1. Sessions — when check-in is open',
    keywords: 'examination date forenoon afternoon fn an check-in window ist overlap import bulk csv xlsx opens closes active',
    body: (<>
      <p>An examination session is one date plus Forenoon (FN) or Afternoon (AN). Each session has its own check-in window, entered in IST — employees can only check in from the opening time up to (but not including) the closing time.</p>
      <p>Create a session on the <strong>Sessions</strong> page before anything else for that exam day. Two active sessions can never have overlapping check-in windows — the system refuses to save one that would overlap.</p>
      <p>A session's date and FN/AN cannot be changed once it has a schedule or any allocation — only its check-in window can still be edited. Deactivating a session stops new check-ins immediately; allocations already made are kept and are not affected.</p>
      <p>Setting up a whole exam period at once? Use <strong>Import sessions</strong> on the Sessions page to upload a CSV or XLSX with Examination Date, Session, Check-in Opens and Check-in Closes (HH:MM, 24-hour IST, same day as the exam date) and an optional Active column. A session that already exists is skipped, never overwritten; a window that overlaps another active session is skipped and reported, without blocking the rest of the file.</p>
    </>),
  },
  {
    id: 'rooms', title: '2. Rooms — where invigilators are placed',
    keywords: 'room code building floor assign capacity invigilator deactivate import bulk csv xlsx',
    body: (<>
      <p>Rooms are a shared list across every session (code, optional building and floor). A room becomes usable for a specific session only after you <strong>assign</strong> it to that session with an invigilator capacity — this is the maximum number of invigilators, not student seats.</p>
      <p>You can raise or lower a room's capacity for a session at any time, but never below the number of people already allocated there. Deactivating a room (or a room's link to one session) stops new allocations but keeps existing ones in place — use this instead of removing a room once it has been used.</p>
      <p>If a session needs many rooms at once, use <strong>Import rooms</strong> on the Rooms page instead of adding them one by one. Upload a CSV or XLSX with the columns Room Code, Building, Floor and Capacity: it creates any new rooms, updates building/floor on existing ones, and assigns every row to the working session with the given capacity — all validated first, so a bad file changes nothing.</p>
    </>),
  },
  {
    id: 'schedule', title: '3. Schedule — who is on duty',
    keywords: 'duty employee id name department import csv xlsx conflict duplicate delete clear session',
    body: (<>
      <p>Import the duty schedule as a CSV or XLSX file from the <strong>Schedule</strong> page. Required columns: Employee ID, Name, Department, Examination Date, Session. Dates accept <code>YYYY-MM-DD</code> or day-first formats; Session accepts FN/Forenoon or AN/Afternoon.</p>
      <p>Every row is validated before anything is saved — invalid rows block the whole import so a bad file is never half-imported. Duplicate rows within the file, and rows that conflict with an already-imported schedule, are shown separately and need your explicit decision (skip or replace) before committing.</p>
      <p>Once imported, you can delete a single entry with the trash icon on its row, or use <strong>Clear session</strong> to remove everyone scheduled for the working session in one action. Anyone with an active allocation or an unresolved verification flag is always kept, never silently deleted — release the allocation or resolve the flag first if you need to remove them too.</p>
    </>),
  },
  {
    id: 'allocations', title: '4. Allocations — rooms as they are actually assigned',
    keywords: 'move reassign release history active released correction',
    body: (<>
      <p>When an employee checks in, the system allocates them to the room with the fewest invigilators so far, so every room fills evenly. The <strong>Allocations</strong> page shows every allocation for a session, active or released.</p>
      <p><strong>Move</strong> reassigns someone to a different eligible room with a reason — the old allocation stays in their history. <strong>Release</strong> ends an active allocation; after a release, the employee cannot simply check in again — an admin must grant re-entry first (Verification page). <strong>History</strong> shows every allocation ever made for that person in that session, oldest first — nothing is ever overwritten.</p>
    </>),
  },
  {
    id: 'verification', title: '5. Verification — flags, late check-in and re-entry',
    keywords: 'flag clear block late reentry re-entry permit identity',
    body: (<>
      <p><strong>Flag an employee</strong> puts their future check-in on hold pending identity verification — they will only see "contact the examination cell" and a short reference, nothing about the reason. Resolve a flag with <strong>Clear</strong> (they can check in normally) or <strong>Block</strong> (they cannot check in to that session at all). Both require a note, recorded permanently.</p>
      <p><strong>Late check-in</strong> and <strong>Re-entry</strong> are one-time permits. Late check-in lets one named, already-scheduled employee check in after the window closes. Re-entry lets a previously released employee be allocated again. Neither skips schedule validation, flags, or room capacity — those rules still apply in full.</p>
    </>),
  },
  {
    id: 'audit', title: '6. Audit log — the permanent record',
    keywords: 'audit log action readable name filter export search permanent immutable who did what',
    body: (<>
      <p>Every sensitive action — imports, moves, releases, flags, authorizations, settings changes, maintenance runs — is written to the audit log automatically, in the same action that performs it. No one, including administrators, can edit or delete an entry. Each entry shows a plain-language action name (for example "Deleted schedule entry"); the exact technical code is shown underneath and included in the export. Search, filter by action or date, and export to CSV for your own records.</p>
    </>),
  },
  {
    id: 'reports', title: '7. Reports — exporting what you see',
    keywords: 'export csv xlsx filter preview formula injection',
    body: (<>
      <p>Pick a report (employee-wise allocations, room-wise, late check-ins, corrections and releases, verification exceptions, and more), filter by session or date range, preview it, then export the exact filtered rows as CSV or XLSX. Any cell beginning with <code>=</code>, <code>+</code>, <code>-</code> or <code>@</code> is automatically prefixed with an apostrophe so spreadsheet software never treats it as a formula.</p>
    </>),
  },
  {
    id: 'settings', title: '8. Settings — branding, QR code, maintenance',
    keywords: 'branding logo institution name qr code maintenance secure zone password sign out devices danger zone backup reset show guide tour walkthrough',
    body: (<>
      <p><strong>Branding</strong> controls the institution name, exam-cell name, application title and logo shown on the public check-in page and on allocation slips. Changes apply immediately for every employee.</p>
      <p><strong>Permanent QR code</strong> — enter the site's live https:// address once it is deployed, then print the generated code once. It never needs to be reprinted, even as exam dates and sessions change, because it only encodes the web address, nothing else.</p>
      <p><strong>Maintenance</strong> clears expired throttle records and abandoned import staging data — run it after each exam period. The audit log is never affected by maintenance.</p>
      <p><strong>Secure zone</strong> shows when you last signed in and when your admin account was created, and has a <strong>Sign out of all devices</strong> button — use it if you think your account may be signed in somewhere you do not recognize. It ends every active session, including this one.</p>
      <p><strong>Backup &amp; reset all data</strong> (Danger zone) is for starting a completely new exam period in a clean system. It downloads every session, room, schedule entry, allocation, verification flag and audit-log entry to this computer as a zip file, then permanently deletes all of it. Your admin login, branding and these settings are kept, so you can sign in immediately afterward. It requires your password and typing "RESET" to confirm, and <strong>cannot be undone</strong> — keep the downloaded zip somewhere safe.</p>
      <p><strong>Show guide</strong> plays this page's on-screen walkthrough again, right away — it does not affect any other page or your next login.</p>
    </>),
  },
  {
    id: 'checklist', title: 'Day-before checklist',
    keywords: 'checklist before exam prepare qr phone backup',
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>Confirm the database project is active (the free Supabase plan pauses after 7 days idle).</li>
        <li>Every administrator can sign in at <code>/admin/login</code>.</li>
        <li>Schedule imported and spot-checked; session check-in windows and room capacities are correct; Free slots ≥ number of scheduled invigilators.</li>
        <li>Export and store a backup: employee-wise allocations, room-wise allocations, and the audit log.</li>
        <li>Scan the printed QR code on two different phones over mobile data to confirm it opens the live HTTPS page.</li>
      </ul>
    ),
  },
  {
    id: 'during', title: 'During check-in — what each message means',
    keywords: 'check-in messages errors not scheduled rooms full verification required',
    body: (<>
      <p>The public check-in page has its own "What does my message mean?" panel listing every result employees can see, in plain language, with what you (the admin) should do about each one. Point invigilators to it before relying on a phone call to the exam cell.</p>
    </>),
  },
  {
    id: 'after', title: 'After the exam period',
    keywords: 'after exam cleanup maintenance deactivate rehearsal test data',
    body: (
      <ul className="list-disc space-y-1 pl-5">
        <li>Export the audit log for the record, then run Settings → Run maintenance now.</li>
        <li>Deactivate sessions and any temporary administrator accounts that are no longer needed.</li>
        <li>Starting fresh for the next period? Use Settings → Backup &amp; reset all data instead of removing rehearsal or test data by hand — it backs everything up first.</li>
      </ul>
    ),
  },
];

export default function Help() {
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return SECTIONS;
    return SECTIONS.filter((s) => {
      const haystack = `${s.title} ${s.keywords}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  }, [q]);

  return (
    <>
      <PageHeader title="Help" subtitle="A written guide to every admin process. The first time you open a page, a short on-screen walkthrough highlights the key controls — replay it any time from Settings." />
      <div className="relative mb-5 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" aria-hidden />
        <Input id="help-search" name="help-search" aria-label="Search the help guide" placeholder="Search for a topic, e.g. “import rooms”" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} data-testid="help-search" />
      </div>
      <div className="space-y-5">
        {filtered.length === 0
          ? <EmptyState title="No matching topics">Try different or fewer words.</EmptyState>
          : filtered.map((s) => (
            <Card key={s.id} title={s.title}>
              <div className="prose-sm space-y-3 text-sm leading-relaxed text-slate-800">{s.body}</div>
            </Card>
          ))}
      </div>
    </>
  );
}

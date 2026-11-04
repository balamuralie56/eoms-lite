import type { ReactNode } from 'react';
import { PageHeader, Card } from '../../components/ui';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <div className="prose-sm space-y-3 text-sm leading-relaxed text-slate-800">{children}</div>
    </Card>
  );
}

export default function Help() {
  return (
    <>
      <PageHeader title="Help" subtitle="A written guide to every admin process. The first time you open a page, a short on-screen walkthrough highlights the key controls — replay it any time from Settings." />
      <div className="space-y-5">
        <Section title="1. Sessions — when check-in is open">
          <p>An examination session is one date plus Forenoon (FN) or Afternoon (AN). Each session has its own check-in window, entered in IST — employees can only check in from the opening time up to (but not including) the closing time.</p>
          <p>Create a session on the <strong>Sessions</strong> page before anything else for that exam day. Two active sessions can never have overlapping check-in windows — the system refuses to save one that would overlap.</p>
          <p>A session's date and FN/AN cannot be changed once it has a schedule or any allocation — only its check-in window can still be edited. Deactivating a session stops new check-ins immediately; allocations already made are kept and are not affected.</p>
        </Section>

        <Section title="2. Rooms — where invigilators are placed">
          <p>Rooms are a shared list across every session (code, optional building and floor). A room becomes usable for a specific session only after you <strong>assign</strong> it to that session with an invigilator capacity — this is the maximum number of invigilators, not student seats.</p>
          <p>You can raise or lower a room's capacity for a session at any time, but never below the number of people already allocated there. Deactivating a room (or a room's link to one session) stops new allocations but keeps existing ones in place — use this instead of removing a room once it has been used.</p>
        </Section>

        <Section title="3. Schedule — who is on duty">
          <p>Import the duty schedule as a CSV or XLSX file from the <strong>Schedule</strong> page. Required columns: Employee ID, Name, Department, Examination Date, Session. Dates accept <code>YYYY-MM-DD</code> or day-first formats; Session accepts FN/Forenoon or AN/Afternoon.</p>
          <p>Every row is validated before anything is saved — invalid rows block the whole import so a bad file is never half-imported. Duplicate rows within the file, and rows that conflict with an already-imported schedule, are shown separately and need your explicit decision (skip or replace) before committing.</p>
          <p>Once imported, you can delete a single entry with the trash icon on its row, or use <strong>Clear session</strong> to remove everyone scheduled for the working session in one action. Anyone with an active allocation or an unresolved verification flag is always kept, never silently deleted — release the allocation or resolve the flag first if you need to remove them too.</p>
        </Section>

        <Section title="4. Allocations — rooms as they are actually assigned">
          <p>When an employee checks in, the system allocates them to the room with the fewest invigilators so far, so every room fills evenly. The <strong>Allocations</strong> page shows every allocation for a session, active or released.</p>
          <p><strong>Move</strong> reassigns someone to a different eligible room with a reason — the old allocation stays in their history. <strong>Release</strong> ends an active allocation; after a release, the employee cannot simply check in again — an admin must grant re-entry first (Verification page). <strong>History</strong> shows every allocation ever made for that person in that session, oldest first — nothing is ever overwritten.</p>
        </Section>

        <Section title="5. Verification — flags, late check-in and re-entry">
          <p><strong>Flag an employee</strong> puts their future check-in on hold pending identity verification — they will only see "contact the examination cell" and a short reference, nothing about the reason. Resolve a flag with <strong>Clear</strong> (they can check in normally) or <strong>Block</strong> (they cannot check in to that session at all). Both require a note, recorded permanently.</p>
          <p><strong>Late check-in</strong> and <strong>Re-entry</strong> are one-time permits. Late check-in lets one named, already-scheduled employee check in after the window closes. Re-entry lets a previously released employee be allocated again. Neither skips schedule validation, flags, or room capacity — those rules still apply in full.</p>
        </Section>

        <Section title="6. Audit log — the permanent record">
          <p>Every sensitive action — imports, moves, releases, flags, authorizations, settings changes, maintenance runs — is written to the audit log automatically, in the same action that performs it. No one, including administrators, can edit or delete an entry. Search, filter by action or date, and export to CSV for your own records.</p>
        </Section>

        <Section title="7. Reports — exporting what you see">
          <p>Pick a report (employee-wise allocations, room-wise, late check-ins, corrections and releases, verification exceptions, and more), filter by session or date range, preview it, then export the exact filtered rows as CSV or XLSX. Any cell beginning with <code>=</code>, <code>+</code>, <code>-</code> or <code>@</code> is automatically prefixed with an apostrophe so spreadsheet software never treats it as a formula.</p>
        </Section>

        <Section title="8. Settings — branding, QR code, maintenance">
          <p><strong>Branding</strong> controls the institution name, exam-cell name, application title and logo shown on the public check-in page and on allocation slips. Changes apply immediately for every employee.</p>
          <p><strong>Permanent QR code</strong> — enter the site's live https:// address once it is deployed, then print the generated code once. It never needs to be reprinted, even as exam dates and sessions change, because it only encodes the web address, nothing else.</p>
          <p><strong>Maintenance</strong> clears expired throttle records and abandoned import staging data — run it after each exam period. The audit log is never affected by maintenance.</p>
          <p><strong>Replay guide</strong> resets the on-screen walkthrough so it shows again the next time you open each admin page.</p>
        </Section>

        <Section title="Day-before checklist">
          <ul className="list-disc space-y-1 pl-5">
            <li>Confirm the database project is active (the free Supabase plan pauses after 7 days idle).</li>
            <li>Every administrator can sign in at <code>/admin/login</code>.</li>
            <li>Schedule imported and spot-checked; session check-in windows and room capacities are correct; Free slots ≥ number of scheduled invigilators.</li>
            <li>Export and store a backup: employee-wise allocations, room-wise allocations, and the audit log.</li>
            <li>Scan the printed QR code on two different phones over mobile data to confirm it opens the live HTTPS page.</li>
          </ul>
        </Section>

        <Section title="During check-in — what each message means">
          <p>The public check-in page has its own "What does my message mean?" panel listing every result employees can see, in plain language, with what you (the admin) should do about each one. Point invigilators to it before relying on a phone call to the exam cell.</p>
        </Section>

        <Section title="After the exam period">
          <ul className="list-disc space-y-1 pl-5">
            <li>Export the audit log for the record, then run Settings → Run maintenance now.</li>
            <li>Deactivate sessions and any temporary administrator accounts that are no longer needed.</li>
            <li>Remove rehearsal or test data — it should never remain in a production project.</li>
          </ul>
        </Section>
      </div>
    </>
  );
}

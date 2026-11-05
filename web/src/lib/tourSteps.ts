import type { TourStep } from '../components/tour/Tour';

const NAV_STEP: TourStep = {
  selector: '[data-tour="nav-list"]',
  title: 'Your admin menu',
  body: 'Every exam-day task lives here: Sessions, Rooms, Schedule, Allocations, Verification, Audit log, Reports and Settings. Open Help any time for the full written guide.',
};

export const TOUR_STEPS: Record<string, TourStep[]> = {
  dashboard: [
    NAV_STEP,
    { selector: '[data-tour="session-picker"]', title: 'Working session', body: 'Pick which exam session the whole admin area shows. Set this first, every time you sign in.' },
    { selector: '[data-testid="stat-cards"]', title: 'Live counts', body: 'Scheduled, Allocated, Pending, Flagged, and free room slots for the selected session — refreshes automatically.' },
  ],
  sessions: [
    NAV_STEP,
    { selector: '[data-testid="new-session"]', title: 'Create a session', body: 'Pick the exam date, Forenoon or Afternoon, and the check-in window in IST. Active sessions can never overlap.' },
    { selector: '[data-testid="import-sessions"]', title: 'Import many sessions at once', body: 'Setting up a whole exam period? Upload a CSV or XLSX with Examination Date, Session, Check-in Opens and Check-in Closes — it creates every session in one validated step.' },
    { selector: 'button[aria-label^="Activate session"], button[aria-label^="Deactivate session"]', title: 'Activate when ready', body: 'Employees can only check in while their session is Active and inside its window. You can deactivate afterwards — existing allocations stay in place.' },
  ],
  rooms: [
    NAV_STEP,
    { selector: '[data-testid="new-room"]', title: 'Add a room', body: 'Give it a code and, optionally, a building and floor. Rooms are shared across every session.' },
    { selector: '[data-testid="import-rooms"]', title: 'Import many rooms at once', body: 'Have 50+ rooms for one session? Upload a CSV or XLSX with Room Code, Building, Floor and Capacity — it creates the rooms and assigns them to the working session in one go.' },
    { selector: '[data-testid="assign-room"]', title: 'Assign to this session', body: 'A room only becomes usable for check-in once it is assigned to the working session with an invigilator capacity.' },
    { selector: 'button[aria-label^="Edit capacity"]', title: 'Capacity', body: 'Adjust capacity any time — it can never be set below the number of people already allocated to that room.' },
  ],
  schedule: [
    NAV_STEP,
    { selector: '[data-testid="open-import"]', title: 'Import the duty schedule', body: 'Upload a CSV or XLSX. Every row is validated before anything is saved — nothing is overwritten without your explicit decision.' },
    { selector: '[aria-label="Session scope"]', title: 'Browse and filter', body: 'Switch between the working session and all sessions, search by name or ID, or filter by status.' },
    { selector: '[data-testid="clear-session-schedule"]', title: 'Delete entries', body: 'Use the trash icon on a row to remove one person, or Clear session to remove everyone at once. Anyone with an active allocation or an unresolved flag is always kept.' },
  ],
  allocations: [
    NAV_STEP,
    { selector: 'button[aria-label^="Move "]', title: 'Move', body: 'Reassign someone to a different room for this session, with a reason. Recorded in the audit log.' },
    { selector: 'button[aria-label^="Release "]', title: 'Release', body: "Ends someone's active allocation with a reason. They can only check in again after an admin grants re-entry." },
    { selector: '[aria-label="Session scope"]', title: 'Filter', body: 'Filter by session, room or state, or search by employee.' },
  ],
  verification: [
    NAV_STEP,
    { selector: '[data-testid="flag-employee"]', title: 'Flag an employee', body: 'Puts a future check-in on hold pending identity verification. They will see "Verification required" until you clear or block them.' },
    { selector: '[aria-label="Flag status"]', title: 'Resolve flags', body: 'Review pending flags here, then Clear or Block each one with a note — always recorded.' },
    { selector: '[data-testid="late-authorize"]', title: 'Late check-in & re-entry', body: 'One-time permits for a late arrival or a re-entry after release. They never skip schedule, capacity or flag checks.' },
  ],
  audit: [
    NAV_STEP,
    { selector: '[data-testid="audit-search"]', title: 'Search everything', body: 'Every admin action — imports, moves, releases, settings changes — is recorded here automatically and can never be deleted.' },
    { selector: '[aria-label="Action filter"]', title: 'Filter and export', body: 'Narrow by action type or date range, then export to CSV for your records.' },
  ],
  reports: [
    NAV_STEP,
    { selector: '[aria-label="Available reports"]', title: 'Pick a report', body: 'Employee-wise and room-wise allocations, late check-ins, corrections and releases, verification exceptions, and more.' },
    { selector: '[data-testid="export-csv"]', title: 'Export', body: 'Download the current report as CSV or XLSX — exactly the rows you are viewing, filtered.' },
  ],
  settings: [
    NAV_STEP,
    { selector: '#b-inst', title: 'Branding', body: 'Institution name, exam-cell name and the title shown on the check-in page. Changes apply immediately for everyone.' },
    { selector: '#qr-url', title: 'Permanent QR code', body: 'Enter your live https:// address once you deploy, then print the code once — it never needs to change, even as sessions change.' },
    { selector: '[data-testid="run-maintenance"]', title: 'Maintenance', body: 'Run this after each exam period to clear old throttle records and abandoned imports. The audit log itself is never touched.' },
    { selector: '[data-testid="open-data-reset"]', title: 'Backup & reset all data', body: 'Starting a new exam period? This downloads every session, room, schedule entry, allocation and audit-log entry as a zip, then wipes them for a clean run. Your admin login and branding are kept.' },
    { selector: '[data-testid="replay-guide"]', title: 'Show guide', body: 'Click here any time to see this page’s walkthrough again, right now, on this page only.' },
  ],
};

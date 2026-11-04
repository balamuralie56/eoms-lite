/** Plain-language reference for every message the check-in page can show. Shown in a disclosure, not live results. */
export interface HelpEntry { title: string; meaning: string }

export const CHECKIN_HELP: HelpEntry[] = [
  { title: 'Your room is allocated / You are already checked in', meaning: 'Success — go to the room shown. Entering your ID again always shows the same room; it never creates a second allocation.' },
  { title: 'No duty found for this session', meaning: "Your Employee ID was not found on today's schedule for this session. Double-check the ID. If it is correct, the examination cell needs to add or fix your schedule entry." },
  { title: 'Check-in is not open right now', meaning: 'Check-in only works during the configured time window for the current session. Too early, too late, or between sessions all show this. If you are genuinely late, ask the examination cell for a late check-in.' },
  { title: 'All rooms are currently full', meaning: 'Every room assigned to this session has reached its invigilator capacity. The examination cell needs to raise a room\'s capacity or assign another room — this cannot be fixed by trying again.' },
  { title: 'Verification required', meaning: 'Your check-in has been placed on hold by the examination cell pending identity verification. Go to the examination cell in person; they will clear or resolve it.' },
  { title: 'Your earlier allocation was released', meaning: 'An admin ended your previous allocation. You cannot simply check in again — the examination cell must authorize your re-entry first, then you enter your ID again.' },
  { title: 'Too many attempts', meaning: 'Too many check-in attempts were made from this connection in a short time. Wait a few minutes and try again. If a whole room is affected, tell IT — it is usually a shared network.' },
  { title: 'The system is busy', meaning: 'Many people are checking in at the same moment. The page retries automatically up to five times — no action needed, just wait a few seconds.' },
  { title: 'Could not reach the server', meaning: 'A connection problem, not a lost entry. Check your internet connection and try again; your Employee ID was not lost.' },
];

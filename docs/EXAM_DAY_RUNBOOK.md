# Exam-day runbook

For the examination-cell staff. Technical terms are explained inline. Keep one printed copy at the desk.
Every procedure below that touches the live system is also recorded in the audit log.

## A. Days before

| When | Check | How |
|---|---|---|
| **Day before** | The database project is **Active** (the free plan pauses projects after a week without activity) | Supabase dashboard -> project. If it says *Paused*, press *Restore* and wait. Then do a test check-in. |
| Day before | Admin accounts work | Every named administrator signs in at `/admin/login`. Anyone who cannot: fix before the day. |
| Day before | Schedule imported and correct | Admin -> **Schedule**: counts match the source sheet; spot-check 5 names. Import history shows the file. |
| Day before | Sessions correct | Admin -> **Sessions**: date, FN/AN, opening/closing time in IST; no overlaps (the system refuses overlaps). |
| Day before | Rooms and capacities | Admin -> **Rooms**: every room used is assigned to the session with the right **invigilator** capacity (not student seats). Dashboard shows *Free slots* >= number of scheduled invigilators. |
| Day before | Backup | Admin -> **Reports**: export *Employee-wise allocations*, *Room-wise*, and **Audit log** (CSV). Store off the system. |
| Day before | QR code | Printed sheets scanned with an iPhone and an Android phone **on mobile data**: opens the HTTPS page with the padlock and today's status. |
| Day before | Mobile smoke test | On two phones: enter a test ID, see the room, download the PNG slip, open it in the gallery. (Use an ID you will then release/ignore.) |

## B. Opening a session

1. Dashboard shows the right date/session and **Check-in open** at the configured time (nothing to press: the server clock opens and closes it).
2. At the opening time watch the dashboard: *Allocated* rises, the room monitor fills **evenly** (every room gets its first invigilator before any gets a second).
3. Keep **Verification** and **Allocations** open in two tabs for exceptions.

## C. During check-in

| Situation | What the employee sees | What you do |
|---|---|---|
| Normal | Room code + PNG slip | Nothing. |
| *No duty found for this session* | NOT_SCHEDULED | Check the schedule for that ID/date/session. If they should be on duty: fix the schedule (import/replace) and ask them to try again. |
| *Verification required* + reference | The employee was flagged | **Verification** -> find the reference -> verify identity in person -> **Clear** (or **Block**) with a note. |
| *All rooms are currently full* | ROOMS_FULL | **Rooms** -> raise a room's capacity or assign another room (capacity cannot go below current allocations). Employee tries again. Never over-allocate by editing the database. |
| *Your earlier allocation was released* | REENTRY_REQUIRES_ADMIN | **Allocations** -> Released -> **Re-entry** with a reason. Employee enters the ID again. |
| *Check-in is not open right now* | NO_ACTIVE_SESSION | If they are late: **Verification -> Late check-in** (employee, reason). It is a **one-time** permission; the employee then enters the ID normally. Capacity still applies. |
| *The system is busy* | BUSY (the page retries by itself, up to 5 tries) | Ask them to wait ~10 s and retry. If widespread, see section E. |
| *Too many attempts* | RATE_LIMITED | Wait a few minutes; if a whole room is behind one network, tell IT. |
| Wrong room / room unusable | - | **Allocations** -> **Move** (reason). Their old allocation stays in the history; they see the new room next time they enter their ID. Deactivate the room for the session if it is unusable. |

**Identity warning.** An Employee ID is not a password. Anyone who knows an ID can obtain that person's slot. At the room,
check the person against their staff card; use *Release* + flag if someone claimed another person's slot.

## D. Closing and reconciliation

1. At the closing time check-in stops by itself (late arrivals: section C).
2. **Reports** -> *Unallocated scheduled employees* for the session: chase those not yet allocated.
3. Export *Session-wise allocations*, *Late check-ins*, *Corrections and releases*, *Verification exceptions* (CSV or XLSX). File them with the paper record.
4. Dashboard *Allocated* should equal the rows in the exported allocation report.

## E. Outage procedures

### E1. The page says "Could not reach the server" for everyone
1. Check your own internet. Try `https://<project-ref>.supabase.co` and the Supabase status page.
2. If the **project is paused** (free plan): dashboard -> Restore (a few minutes). Test with one ID.
3. If it is a platform outage: go to the **manual fallback** (E3). Do **not** edit the database by hand to "help".

### E2. Slow / many BUSY
The allocation step is serialised per session by design (this is what guarantees no duplicates and no over-capacity). Under extreme
bursts some requests answer BUSY and the page retries. Ask people to queue in groups of ~50. The dashboard shows the true state.

### E3. Manual fallback (no system)
1. Use the **latest exported** "Room-wise allocations" and "Employee-wise allocations" (taken the day before).
2. Run the allocation on paper by the **same rule**: list the rooms with their capacities; give each arriving invigilator to a room that has the
   **fewest** invigilators so far (every room gets 1 before any gets 2, and so on); break ties by drawing a number.
3. Write each allocation on a log sheet (ID, name, room, time).
4. After recovery, enter the log: Allocations cannot be added by hand, so re-run check-in for each person in order (the engine will place them) and
   then **Move** anyone whose paper room differs, with reason "paper fallback". Everything is audited.

### E4. Recovery and backups
There are **no automatic backups on the free plan.** The protection is: exports taken after every session, the SQL migrations in Git, and the audit log
export. To restore into a new project: apply the migrations, bootstrap an admin, re-import the schedule from the original files.
(The allocation history lives only in the database/exports.)

## F. After the exam period

* Export the audit log (CSV) for the record. Run *Settings -> Run maintenance now*.
* Deactivate sessions and any temporary administrators.
* Rehearsal data should never remain in the production project.

/** Human-readable labels for audit_log.action codes — shown instead of the raw dotted code, which stays
 * available in the detail row and the CSV/XLSX export for anyone who needs the exact value. */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  'allocation.create': 'Allocated a room',
  'allocation.reassign': 'Moved to another room',
  'allocation.release': 'Released an allocation',
  'authorization.late': 'Authorized a late check-in',
  'authorization.reentry': 'Authorized a re-entry',
  'authorization.revoke': 'Revoked an authorization',
  'flag.create': 'Flagged an employee',
  'flag.resolve': 'Resolved a verification flag',
  'import.abandoned_cleanup': 'Cleaned up an abandoned import',
  'import.begin': 'Started a schedule import',
  'import.cancel': 'Cancelled a schedule import',
  'import.commit': 'Committed a schedule import',
  'import.commit_failed': 'Schedule import failed',
  'import.commit_rejected': 'Schedule import rejected',
  'import.replace_conflicts': 'Replaced conflicting schedule rows',
  'import.validate': 'Validated a schedule import',
  'maintenance.run': 'Ran maintenance',
  'room.create': 'Created a room',
  'room.update': 'Updated a room',
  'room.activate': 'Activated a room',
  'room.deactivate': 'Deactivated a room',
  'schedule.clear_session': 'Cleared a session’s schedule',
  'schedule.delete_entry': 'Deleted a schedule entry',
  'schedule.replace': 'Replaced a schedule entry',
  'session.create': 'Created an examination session',
  'session.update': 'Updated an examination session',
  'session.activate': 'Activated a session',
  'session.deactivate': 'Deactivated a session',
  'session_room.assign': 'Assigned a room to a session',
  'session_room.update': 'Updated a room’s capacity',
  'session_room.update_capacity': 'Updated a room’s capacity',
  'session_room.activate': 'Activated a room for a session',
  'session_room.deactivate': 'Deactivated a room for a session',
  'session_room.remove': 'Removed a room from a session',
  'settings.update': 'Updated settings',
  'system.full_reset': 'Backed up and reset all data',
};

/** Falls back to a title-cased version of the raw code for any action not in the table above, so a new or
 * unmapped action code is still readable rather than silently missing. */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

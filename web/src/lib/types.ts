export type CheckinCode =
  | 'ALLOCATED' | 'ALREADY_ALLOCATED' | 'NOT_SCHEDULED' | 'NO_ACTIVE_SESSION' | 'ROOMS_FULL'
  | 'VERIFICATION_REQUIRED' | 'REENTRY_REQUIRES_ADMIN' | 'RATE_LIMITED' | 'INVALID_ID' | 'BUSY';

/** Client-side-only outcomes, never produced by the database. */
export type ClientCode = 'NETWORK' | 'UNKNOWN';

export interface AllocationInfo {
  employee_id: string;
  employee_name: string | null;
  department: string | null;
  exam_date: string;
  session: 'FN' | 'AN';
  room_code: string;
  building: string | null;
  floor: string | null;
  round: number;
  allocated_at: string;
  reference: string;
}

export type CheckinResult =
  | ({ ok: true; code: 'ALLOCATED' | 'ALREADY_ALLOCATED' } & AllocationInfo)
  | { ok: false; code: Exclude<CheckinCode, 'ALLOCATED' | 'ALREADY_ALLOCATED'> | ClientCode; message?: string; reference?: string };

export interface CheckinStatus {
  state: 'OPEN' | 'CLOSED';
  server_time: string;
  exam_date?: string;
  session?: 'FN' | 'AN';
  checkin_closes_at?: string;
}

export interface PublicConfig {
  institution_name: string;
  exam_cell_name: string;
  app_title: string;
  logo_data_url: string | null;
  contact_instructions: string;
  support_info: string | null;
}

export interface SessionSummary {
  id: string;
  exam_date: string;
  session_label: 'FN' | 'AN';
  is_active: boolean;
  checkin_opens_at: string;
  checkin_closes_at: string;
  opens_ist: string;
  closes_ist: string;
  scheduled: number;
  allocated: number;
  room_links: number;
  total_slots: number;
  state: 'INACTIVE' | 'UPCOMING' | 'CLOSED' | 'OPEN';
}

export interface Overview {
  server_time: string;
  state: 'NONE' | 'INACTIVE' | 'UPCOMING' | 'CLOSED' | 'OPEN';
  session: null | {
    id: string; exam_date: string; session: 'FN' | 'AN'; is_active: boolean;
    checkin_opens_at: string; checkin_closes_at: string;
    checkin_opens_at_ist: string; checkin_closes_at_ist: string;
  };
  counts: null | {
    scheduled: number; allocated: number; pending: number; flagged: number; released: number;
    active_rooms: number; full_rooms: number; total_slots: number; available_slots: number;
  };
  recent: Array<{
    allocation_id: string; employee_id: string; employee_name: string | null; room_code: string;
    round: number; source: string; allocated_at: string; released_at: string | null;
  }>;
}

export interface RoomMonitorRow {
  session_room_id: string; room_id: string; room_code: string; building: string | null; floor: string | null;
  capacity: number; allocated: number; available: number; link_active: boolean; room_active: boolean;
  status: 'inactive' | 'full' | 'available';
}

export interface RoomRow {
  id: string; room_code: string; building: string | null; floor: string | null; is_active: boolean;
  session_links: number; active_allocations: number;
}

export interface Paged<T> { total: number; rows: T[] }

export interface ScheduleRow {
  employee_id: string; employee_name: string; department: string; exam_date: string; session_label: 'FN' | 'AN';
  state: 'allocated' | 'released' | 'flagged' | 'pending'; room_code: string | null;
  import_batch_id: string | null; import_filename: string | null;
}

export interface AllocationRow {
  id: string; seq: number; session_id: string; exam_date: string; session_label: 'FN' | 'AN';
  employee_id: string; employee_name: string | null; department: string | null;
  session_room_id: string; room_code: string; building: string | null; floor: string | null;
  round: number; source: string; allocated_at: string; released_at: string | null;
  release_reason: string | null; supersedes_allocation_id: string | null;
}

export interface HistoryRow {
  id: string; room_code: string; round: number; source: string; allocated_at: string;
  released_at: string | null; release_reason: string | null; released_by: string | null;
  created_by: string | null; supersedes_allocation_id: string | null;
}

export interface FlagRow {
  id: string; session_id: string; exam_date: string; session_label: 'FN' | 'AN'; employee_id: string;
  employee_name: string | null; department: string | null; reason: string; status: 'pending' | 'blocked' | 'cleared';
  created_at: string; created_by_name: string; resolved_at: string | null; resolved_by_name: string | null;
  resolution_note: string | null; reference: string;
}

export interface AuthorizationRow {
  id: string; kind: 'late' | 'reentry'; session_id: string; exam_date: string; session_label: 'FN' | 'AN';
  employee_id: string; employee_name: string | null; reason: string; authorized_by_name: string;
  authorized_at: string; expires_at: string | null; consumed_at: string | null; revoked_at: string | null;
  status: 'open' | 'consumed' | 'revoked' | 'expired';
}

export interface AuditRow {
  id: number; at: string; actor: string; admin_name: string | null; action: string; entity: string | null;
  entity_id: string | null; before: unknown; after: unknown; request_id: string | null;
}

export interface ImportRowOut {
  row: number; status: string; errors: string[]; outcome: string | null; employee_id: string | null;
  name: string | null; department: string | null; date: string | null; session: string | null;
  existing: { employee_name: string; department: string } | null;
}

export interface ImportSummary {
  batch_id: string; status: string; filename: string; rows: number; valid: number; invalid: number;
  duplicate: number; duplicate_in_batch: number; exact_duplicate_existing: number; conflict: number;
  inserted: number; replaced: number; error: string | null;
}

export interface ImportBatchRow {
  id: string; filename: string; status: string; uploaded_at: string; uploaded_by_name: string;
  committed_at: string | null; row_count: number; valid_count: number; invalid_count: number;
  duplicate_count: number; conflict_count: number; inserted_count: number; replaced_count: number; error: string | null;
}

export interface ReportResult {
  report: string; columns: string[]; rows: Array<Record<string, unknown>>; total: number;
}

export interface AdminSettings extends PublicConfig {
  id: number; default_items_per_page: number; updated_at: string;
  retention: Record<string, number>;
}

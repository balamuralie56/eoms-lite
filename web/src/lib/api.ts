import { callRpc } from './rpc';
import type {
  AdminSettings, AllocationRow, AuditRow, AuthorizationRow, FlagRow, HistoryRow, ImportBatchRow, ImportRowOut,
  ImportSummary, Overview, Paged, PublicConfig, ReportResult, RoomMonitorRow, RoomRow, ScheduleRow, SessionSummary,
  CheckinStatus,
} from './types';

/**
 * Thin typed wrappers over the database RPCs. Every privileged operation lives in a SECURITY DEFINER function that
 * re-verifies the admin; nothing here writes a table directly. Parameter names are the SQL parameter names.
 */
export const api = {
  // ---- public ----
  status: () => callRpc<CheckinStatus>('get_checkin_status'),
  publicConfig: () => callRpc<PublicConfig>('get_public_config'),
  checkin: (employeeId: string) => callRpc<unknown>('checkin', { p_employee_id: employeeId }),
  isAdmin: () => callRpc<boolean>('is_admin'),

  // ---- dashboard / monitor ----
  overview: (sessionId: string | null = null) => callRpc<Overview>('admin_overview', { p_session_id: sessionId }),
  roomMonitor: (sessionId: string) => callRpc<RoomMonitorRow[]>('admin_room_monitor', { p_session_id: sessionId }),

  // ---- sessions ----
  listSessions: () => callRpc<SessionSummary[]>('admin_list_sessions'),
  createSession: (p: { date: string; label: string; opens: string; closes: string; active: boolean }) =>
    callRpc<{ ok: true; session: { id: string } }>('admin_create_session', {
      p_exam_date: p.date, p_session_label: p.label, p_opens_local: p.opens, p_closes_local: p.closes, p_is_active: p.active,
    }),
  updateSession: (id: string, p: { date?: string; label?: string; opens?: string; closes?: string }) =>
    callRpc<{ ok: true }>('admin_update_session', {
      p_session_id: id, p_exam_date: p.date ?? null, p_session_label: p.label ?? null,
      p_opens_local: p.opens ?? null, p_closes_local: p.closes ?? null,
    }),
  setSessionActive: (id: string, active: boolean, reason: string, confirm: boolean) =>
    callRpc<{ ok: true; active_allocations?: number }>('admin_set_session_active', {
      p_session_id: id, p_active: active, p_reason: reason, p_confirm: confirm,
    }),

  // ---- rooms ----
  listRooms: () => callRpc<RoomRow[]>('admin_list_rooms'),
  createRoom: (code: string, building: string | null, floor: string | null) =>
    callRpc<{ ok: true }>('admin_create_room', { p_room_code: code, p_building: building, p_floor: floor }),
  updateRoom: (id: string, p: { code?: string; building?: string; floor?: string; confirm?: boolean }) =>
    callRpc<{ ok: true }>('admin_update_room', {
      p_room_id: id, p_room_code: p.code ?? null, p_building: p.building ?? null, p_floor: p.floor ?? null,
      p_confirm: p.confirm ?? false,
    }),
  setRoomActive: (id: string, active: boolean, reason: string, confirm: boolean) =>
    callRpc<{ ok: true }>('admin_set_room_active', { p_room_id: id, p_active: active, p_reason: reason, p_confirm: confirm }),
  assignRoom: (sessionId: string, roomId: string, cap: number) =>
    callRpc<{ ok: true }>('admin_assign_room_to_session', { p_session_id: sessionId, p_room_id: roomId, p_max_invigilators: cap }),
  updateSessionRoom: (id: string, cap: number) =>
    callRpc<{ ok: true }>('admin_update_session_room', { p_session_room_id: id, p_max_invigilators: cap }),
  setSessionRoomActive: (id: string, active: boolean, reason: string, confirm: boolean) =>
    callRpc<{ ok: true }>('admin_set_session_room_active', {
      p_session_room_id: id, p_active: active, p_reason: reason, p_confirm: confirm,
    }),
  removeSessionRoom: (id: string, reason: string) =>
    callRpc<{ ok: true }>('admin_remove_session_room', { p_session_room_id: id, p_reason: reason }),

  // ---- schedule ----
  listSchedule: (p: { sessionId: string | null; search: string; status: string | null; limit: number; offset: number }) =>
    callRpc<Paged<ScheduleRow>>('admin_list_schedule', {
      p_session_id: p.sessionId, p_search: p.search || null, p_status: p.status, p_limit: p.limit, p_offset: p.offset,
    }),
  deleteScheduleEntry: (employeeId: string, examDate: string, sessionLabel: string) =>
    callRpc<{ ok: true }>('admin_delete_schedule_entry', {
      p_employee_id: employeeId, p_exam_date: examDate, p_session_label: sessionLabel,
    }),
  clearSessionSchedule: (sessionId: string, confirm: boolean) =>
    callRpc<{ ok: true; would_delete?: number; would_skip?: number; deleted?: number; skipped?: number }>(
      'admin_clear_session_schedule', { p_session_id: sessionId, p_confirm: confirm },
    ),

  // ---- allocations ----
  listAllocations: (p: { sessionId: string | null; sessionRoomId: string | null; search: string; state: string; limit: number; offset: number }) =>
    callRpc<Paged<AllocationRow>>('admin_list_allocations', {
      p_session_id: p.sessionId, p_session_room_id: p.sessionRoomId, p_search: p.search || null,
      p_state: p.state, p_limit: p.limit, p_offset: p.offset,
    }),
  allocationHistory: (sessionId: string, employeeId: string) =>
    callRpc<HistoryRow[]>('admin_allocation_history', { p_session_id: sessionId, p_employee_id: employeeId }),
  release: (allocationId: string, reason: string) =>
    callRpc<{ ok: true }>('admin_release', { p_allocation_id: allocationId, p_reason: reason }),
  reassign: (allocationId: string, newSessionRoomId: string, reason: string) =>
    callRpc<{ ok: true }>('admin_reassign', { p_allocation_id: allocationId, p_new_session_room_id: newSessionRoomId, p_reason: reason }),

  // ---- verification / authorizations ----
  listFlags: (p: { status: string | null; sessionId: string | null; search: string; limit: number; offset: number }) =>
    callRpc<Paged<FlagRow>>('admin_list_flags', {
      p_status: p.status, p_session_id: p.sessionId, p_search: p.search || null, p_limit: p.limit, p_offset: p.offset,
    }),
  flagEmployee: (employeeId: string, sessionId: string, reason: string) =>
    callRpc<{ ok: true; reference: string }>('admin_flag_employee', { p_employee_id: employeeId, p_session_id: sessionId, p_reason: reason }),
  resolveFlag: (flagId: string, decision: 'cleared' | 'blocked', note: string) =>
    callRpc<{ ok: true }>('admin_resolve_flag', { p_flag_id: flagId, p_decision: decision, p_note: note }),
  listAuthorizations: (p: { sessionId: string | null; kind: string | null; status: string | null; search: string; limit: number; offset: number }) =>
    callRpc<Paged<AuthorizationRow>>('admin_list_authorizations', {
      p_session_id: p.sessionId, p_kind: p.kind, p_status: p.status, p_search: p.search || null, p_limit: p.limit, p_offset: p.offset,
    }),
  authorizeLate: (employeeId: string, sessionId: string, reason: string) =>
    callRpc<{ ok: true }>('admin_authorize_late', { p_employee_id: employeeId, p_session_id: sessionId, p_reason: reason }),
  authorizeReentry: (employeeId: string, sessionId: string, reason: string) =>
    callRpc<{ ok: true }>('admin_authorize_reentry', { p_employee_id: employeeId, p_session_id: sessionId, p_reason: reason }),
  revokeAuthorization: (id: string, reason: string) =>
    callRpc<{ ok: true }>('admin_revoke_authorization', { p_authorization_id: id, p_reason: reason }),

  // ---- audit / reports ----
  listAudit: (p: { search: string; action: string | null; from: string | null; to: string | null; limit: number; offset: number }) =>
    callRpc<Paged<AuditRow> & { actions: string[] }>('admin_list_audit', {
      p_search: p.search || null, p_action: p.action, p_from: p.from, p_to: p.to, p_limit: p.limit, p_offset: p.offset,
    }),
  report: (p: { report: string; sessionId: string | null; from: string | null; to: string | null; limit: number; offset: number }) =>
    callRpc<ReportResult>('admin_report', {
      p_report: p.report, p_session_id: p.sessionId, p_from: p.from, p_to: p.to, p_limit: p.limit, p_offset: p.offset,
    }),

  // ---- import ----
  listImports: (limit: number, offset: number) => callRpc<Paged<ImportBatchRow>>('admin_list_imports', { p_limit: limit, p_offset: offset }),
  importBegin: (filename: string, bytes: number, rows: number) =>
    callRpc<{ ok: true; batch_id: string; limits: { max_rows: number; max_chunk_rows: number; max_file_bytes: number } }>(
      'admin_import_begin', { p_filename: filename, p_file_size_bytes: bytes, p_declared_rows: rows }),
  importAddRows: (batchId: string, rows: unknown[]) =>
    callRpc<{ ok: true; staged_rows: number }>('admin_import_add_rows', { p_batch_id: batchId, p_rows: rows }),
  importValidate: (batchId: string) =>
    callRpc<{ ok: true; summary: ImportSummary; problems: ImportRowOut[] }>('admin_import_validate', { p_batch_id: batchId }),
  importPreview: (batchId: string, status: string | null, limit: number, offset: number) =>
    callRpc<{ summary: ImportSummary; rows: ImportRowOut[] }>('admin_import_preview', {
      p_batch_id: batchId, p_status: status, p_limit: limit, p_offset: offset }),
  importCancel: (batchId: string, reason: string) => callRpc<{ ok: true }>('admin_import_cancel', { p_batch_id: batchId, p_reason: reason }),
  importCommit: (batchId: string, onConflict: 'skip' | 'abort' | null) =>
    callRpc<{ ok: boolean; code?: string; message?: string; summary?: ImportSummary }>('admin_import_commit', {
      p_batch_id: batchId, p_confirm: true, p_on_conflict: onConflict }),
  importReplaceConflicts: (batchId: string, reason: string) =>
    callRpc<{ ok: true; replaced: number; summary: ImportSummary }>('admin_import_replace_conflicts', {
      p_batch_id: batchId, p_confirm: true, p_reason: reason }),

  // ---- settings / maintenance ----
  getSettings: () => callRpc<AdminSettings>('admin_get_settings'),
  updateSettings: (p: {
    institution?: string; cell?: string; title?: string; logo?: string | null; clearLogo?: boolean;
    contact?: string; support?: string; perPage?: number;
  }) =>
    callRpc<PublicConfig & { ok: true }>('admin_update_settings', {
      p_institution_name: p.institution ?? null, p_exam_cell_name: p.cell ?? null, p_app_title: p.title ?? null,
      p_logo_data_url: p.logo ?? null, p_clear_logo: p.clearLogo ?? false, p_contact_instructions: p.contact ?? null,
      p_support_info: p.support ?? null, p_items_per_page: p.perPage ?? null,
    }),
  runMaintenance: () => callRpc<Record<string, number | boolean>>('admin_run_maintenance'),
  debugHeaders: () => callRpc<{ headers: Record<string, string>; client_ip_hash_used: string | null }>('admin_debug_request_headers'),
};

import { useCallback, useState, type DragEvent } from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { checkFile } from '../lib/importParse';
import { parseRoomsFile, MAX_ROWS, type ParsedRoomRow, type RoomParseResult } from '../lib/roomImportParse';
import { errText } from '../lib/adminHooks';
import { Alert, Button, ConfirmDialog, DataTable, Modal, StatCard, useToast, cx } from './ui';

type Step = 'upload' | 'preview' | 'validating' | 'results' | 'report';

interface ImportOutcome {
  rows: number; valid: number; invalid: number;
  errors: Array<{ row: number; room_code: string; errors: string[] }>;
  would_create_rooms: number; would_update_rooms: number; would_assign: number; would_update_capacity: number;
}

export default function RoomImportWizard({ sessionId, sessionLabel, onClose, onChanged }:
  { sessionId: string; sessionLabel: string; onClose: () => void; onChanged: () => void }) {
  const { push } = useToast();
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<RoomParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [workError, setWorkError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [report, setReport] = useState<{ created_rooms: number; updated_rooms: number; assigned: number; updated_capacity: number; unchanged: number } | null>(null);

  const rowsAsPayload = (rows: ParsedRoomRow[]) =>
    rows.map((r) => ({ room_code: r.room_code, building: r.building, floor: r.floor, capacity: r.capacity }));

  const choose = useCallback(async (f: File) => {
    setParseError(null); setParsed(null); setFile(f);
    const head = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
    const check = checkFile(f, head);
    if ('error' in check) { setParseError(check.error); return; }
    setParsing(true);
    try {
      const res = await parseRoomsFile(f);
      if (res.headerErrors.length) { setParseError(res.headerErrors.join(' ')); return; }
      if (res.rows.length > MAX_ROWS) { setParseError(`The file has ${res.rows.length} rows; the limit is ${MAX_ROWS} per import.`); return; }
      setParsed(res); setStep('preview');
    } catch (e) { setParseError(errText(e)); }
    finally { setParsing(false); }
  }, []);

  const validate = async () => {
    if (!parsed) return;
    setStep('validating'); setWorkError(null);
    try {
      const r = await api.importRooms(sessionId, rowsAsPayload(parsed.rows), false);
      setOutcome({
        rows: r.rows ?? 0, valid: r.valid ?? 0, invalid: r.invalid ?? 0, errors: r.errors ?? [],
        would_create_rooms: r.would_create_rooms ?? 0, would_update_rooms: r.would_update_rooms ?? 0,
        would_assign: r.would_assign ?? 0, would_update_capacity: r.would_update_capacity ?? 0,
      });
      setStep('results');
    } catch (e) { setWorkError(errText(e)); setStep('preview'); }
  };

  const commit = async () => {
    if (!parsed) return;
    const r = await api.importRooms(sessionId, rowsAsPayload(parsed.rows), true);
    setReport({
      created_rooms: r.created_rooms ?? 0, updated_rooms: r.updated_rooms ?? 0,
      assigned: r.assigned ?? 0, updated_capacity: r.updated_capacity ?? 0, unchanged: r.unchanged ?? 0,
    });
    setStep('report');
    onChanged();
    push('success', 'Rooms imported');
  };

  return (
    <Modal title={`Import rooms into ${sessionLabel}`} onClose={onClose} wide
      footer={step === 'upload' || step === 'report' ? <Button onClick={onClose}>{step === 'report' ? 'Done' : 'Close'}</Button> : undefined}>
      {step === 'upload' && (
        <div className="space-y-3">
          <div
            onDragOver={(e: DragEvent) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
            onDrop={(e: DragEvent) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void choose(f); }}
            className={cx('rounded-xl border-2 border-dashed p-8 text-center', dragOver ? 'border-blue-700 bg-blue-50' : 'border-slate-300')}>
            <FileSpreadsheet className="mx-auto h-10 w-10 text-slate-500" aria-hidden />
            <p className="mt-2 font-semibold text-slate-900">Drop a .csv or .xlsx file here</p>
            <p className="text-sm text-slate-600">or</p>
            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-700">
              <Upload className="h-4 w-4" aria-hidden />Choose file
              <input type="file" accept=".csv,.xlsx" className="sr-only" data-testid="room-import-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); e.target.value = ''; }} />
            </label>
            {parsing && <p role="status" className="mt-3 text-sm text-slate-700">Reading {file?.name}…</p>}
          </div>
          {parseError && <Alert tone="error" title="This file cannot be imported">{parseError}</Alert>}
          <Alert tone="info" title="Required columns">
            <p><strong>Room Code, Capacity</strong> are required. <strong>Building</strong> and <strong>Floor</strong> are optional. Capacity is the maximum invigilators for this session, 1 to 100. Other columns are ignored. Up to {MAX_ROWS} rows per import.</p>
          </Alert>
        </div>
      )}

      {(step === 'preview' || step === 'validating') && parsed && (
        <div className="space-y-3">
          <Alert tone="info" title={`${file?.name}: ${parsed.rows.length} data rows read`}>
            Nothing has been sent yet. {parsed.ignoredColumns.length > 0 && <>Ignored columns: {parsed.ignoredColumns.join(', ')}. </>}{parsed.blankRowsSkipped > 0 && <>{parsed.blankRowsSkipped} blank rows skipped.</>}
          </Alert>
          <DataTable caption="First rows of the file" rows={parsed.rows.slice(0, 20)} rowKey={(r) => String(r.row)}
            columns={[
              { key: 'row', header: 'Row', cell: (r) => r.row }, { key: 'code', header: 'Room code', cell: (r) => r.room_code },
              { key: 'building', header: 'Building', cell: (r) => r.building || '-' }, { key: 'floor', header: 'Floor', cell: (r) => r.floor || '-' },
              { key: 'cap', header: 'Capacity', cell: (r) => r.capacity },
            ]} />
          {parsed.rows.length > 20 && <p className="text-xs text-slate-600">Showing the first 20 of {parsed.rows.length} rows.</p>}
          {workError && <Alert tone="error" title="Validation could not be completed">{workError}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => { setStep('upload'); setParsed(null); setFile(null); }}>Choose another file</Button>
            <Button onClick={validate} loading={step === 'validating'} data-testid="validate-rooms">Validate with the server</Button>
          </div>
        </div>
      )}

      {step === 'results' && outcome && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="room-validation-summary">
            <StatCard label="Valid" value={outcome.valid} tone="green" hint="Will be processed" />
            <StatCard label="Invalid" value={outcome.invalid} tone={outcome.invalid ? 'red' : undefined} hint="Blocks the import" />
            <StatCard label="New rooms" value={outcome.would_create_rooms} />
            <StatCard label="Capacity changes" value={outcome.would_update_capacity + outcome.would_assign} hint="Assigned or updated" />
          </div>
          {outcome.invalid > 0 && (
            <Alert tone="error" title="Fix the file before importing">
              {outcome.invalid} rows have errors. Invalid rows block the whole import so a bad file is never half-imported.
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {outcome.errors.slice(0, 30).map((e) => (
                  <li key={e.row}><strong>Row {e.row}</strong> ({e.room_code || '(blank)'}): {e.errors.join('; ')}</li>
                ))}
              </ul>
              {outcome.errors.length > 30 && <p className="mt-1">…and {outcome.errors.length - 30} more rows.</p>}
            </Alert>
          )}
          {outcome.invalid === 0 && (
            <Alert tone="info">
              {outcome.would_create_rooms} new room{outcome.would_create_rooms === 1 ? '' : 's'} will be created, {outcome.would_update_rooms} updated.
              {' '}{outcome.would_assign} room{outcome.would_assign === 1 ? '' : 's'} will be assigned to this session, {outcome.would_update_capacity} will have their capacity changed.
            </Alert>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => { setStep('upload'); setParsed(null); setFile(null); setOutcome(null); }}>Choose another file</Button>
            <Button disabled={outcome.invalid > 0} onClick={() => setConfirming(true)} data-testid="commit-room-import">Import {outcome.valid} rooms…</Button>
          </div>
        </div>
      )}

      {step === 'report' && report && (
        <div className="space-y-4" data-testid="room-import-report">
          <Alert tone="success" title="Import complete">
            {report.created_rooms} room{report.created_rooms === 1 ? '' : 's'} created, {report.assigned} assigned to this session.
          </Alert>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Rooms created" value={report.created_rooms} tone="green" />
            <StatCard label="Rooms updated" value={report.updated_rooms} />
            <StatCard label="Newly assigned" value={report.assigned} tone="green" />
            <StatCard label="Capacity changed" value={report.updated_capacity} />
          </div>
        </div>
      )}

      {confirming && outcome && (
        <ConfirmDialog title="Import these rooms?" confirmLabel={`Import ${outcome.valid} rooms`} onClose={() => setConfirming(false)} onConfirm={commit}>
          <p>{outcome.would_create_rooms} new rooms will be created and {outcome.would_assign} rooms assigned to this session with the given capacity.
            {' '}{outcome.would_update_rooms + outcome.would_update_capacity > 0 && <>{outcome.would_update_rooms} rooms and {outcome.would_update_capacity} capacities will be updated. </>}
            The data is checked again on the server first, and the import is all-or-nothing.</p>
        </ConfirmDialog>
      )}
    </Modal>
  );
}

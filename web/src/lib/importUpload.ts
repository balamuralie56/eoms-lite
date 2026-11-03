import { api } from './api';
import { ApiError } from './rpc';
import type { ParsedRow } from './importParse';
import { backoffDelay, defaultSleep } from './checkin';

export class UploadError extends Error {
  /** index of the first row not yet confirmed by the server: pass it back to resume */
  nextIndex: number;
  constructor(message: string, nextIndex: number) {
    super(message);
    this.name = 'UploadError';
    this.nextIndex = nextIndex;
  }
}

export interface UploadDeps {
  addRows: (batchId: string, rows: unknown[]) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface UploadOptions {
  chunkSize: number;
  /** attempts per chunk (default 4: initial + 3 retries) */
  attempts?: number;
  baseDelayMs?: number;
  onProgress?: (uploaded: number, total: number) => void;
}

const toPayload = (r: ParsedRow) => ({
  row: r.row, employee_id: r.employee_id, name: r.name, department: r.department, date: r.date, session: r.session,
});

/**
 * Sends rows in bounded chunks, each retried with exponential backoff. Chunks are idempotent in the database (upsert per
 * row number), so a retry after a lost response never duplicates rows. If a chunk still fails, throws UploadError with
 * the index to resume from; the same batch can be continued without re-sending what already arrived.
 */
export async function uploadRows(
  batchId: string, rows: ParsedRow[], opts: UploadOptions, deps: UploadDeps = { addRows: api.importAddRows },
  from = 0,
): Promise<void> {
  const attempts = opts.attempts ?? 4;
  const sleep = deps.sleep ?? ((ms: number) => defaultSleep(ms));
  const rnd = deps.random ?? Math.random;
  const size = Math.max(1, Math.min(opts.chunkSize, 500));
  for (let i = from; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size).map(toPayload);
    for (let a = 0; ; a++) {
      try {
        await deps.addRows(batchId, chunk);
        break;
      } catch (e) {
        const retryable = !(e instanceof ApiError) || e.isNetwork || e.status >= 500;
        if (!retryable || a + 1 >= attempts) {
          throw new UploadError(e instanceof Error ? e.message : 'Upload failed', i);
        }
        await sleep(backoffDelay(a, opts.baseDelayMs ?? 500, 8000, rnd));
      }
    }
    opts.onProgress?.(Math.min(i + size, rows.length), rows.length);
  }
}

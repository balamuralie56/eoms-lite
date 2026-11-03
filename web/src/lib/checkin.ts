import type { CheckinCode, CheckinResult, PublicConfig } from './types';
import { ApiError } from './rpc';

export type Tone = 'success' | 'info' | 'warning' | 'error';
export interface Outcome { tone: Tone; title: string; body: string }

/**
 * Employee-facing wording for every result. Deliberately generic: a rejection never confirms whether an arbitrary
 * Employee ID exists, never repeats internal administrative reasons, and always points at the examination cell.
 */
export function describeOutcome(r: CheckinResult, cfg: Pick<PublicConfig, 'contact_instructions' | 'exam_cell_name'>): Outcome {
  const contact = cfg.contact_instructions || `Please contact the ${cfg.exam_cell_name}.`;
  switch (r.code) {
    case 'ALLOCATED':
      return { tone: 'success', title: 'Your room is allocated', body: 'Please proceed to the room shown below.' };
    case 'ALREADY_ALLOCATED':
      return { tone: 'success', title: 'You are already checked in', body: 'Here is your existing allocation. It has not changed.' };
    case 'NOT_SCHEDULED':
      return { tone: 'warning', title: 'No duty found for this session', body: `Check your Employee ID and try again. If it is correct: ${contact}` };
    case 'NO_ACTIVE_SESSION':
      return { tone: 'info', title: 'Check-in is not open right now', body: `Check-in opens only during the configured window. If your session has ended: ${contact}` };
    case 'ROOMS_FULL':
      return { tone: 'warning', title: 'All rooms are currently full', body: contact };
    case 'VERIFICATION_REQUIRED':
      return { tone: 'warning', title: 'Verification required', body: `Your check-in needs to be verified by the examination cell. ${contact}` };
    case 'REENTRY_REQUIRES_ADMIN':
      return { tone: 'warning', title: 'Your earlier allocation was released', body: contact };
    case 'RATE_LIMITED':
      return { tone: 'error', title: 'Too many attempts', body: `Please wait a few minutes before trying again. ${contact}` };
    case 'INVALID_ID':
      return { tone: 'error', title: 'Enter a valid Employee ID', body: 'Use letters, digits and . _ / - only (up to 50 characters).' };
    case 'BUSY':
      return { tone: 'warning', title: 'The system is busy', body: 'Many people are checking in at once. Please try again in a moment.' };
    case 'NETWORK':
      return { tone: 'error', title: 'Could not reach the server', body: 'Check your internet connection and try again. Your Employee ID was not lost.' };
    default:
      return { tone: 'error', title: 'Something went wrong', body: `Please try again. If it keeps happening: ${contact}` };
  }
}


const KNOWN = new Set(['ALLOCATED', 'ALREADY_ALLOCATED', 'NOT_SCHEDULED', 'NO_ACTIVE_SESSION', 'ROOMS_FULL',
  'VERIFICATION_REQUIRED', 'REENTRY_REQUIRES_ADMIN', 'RATE_LIMITED', 'INVALID_ID', 'BUSY']);

/** Validates what came back from the RPC; anything unexpected becomes UNKNOWN rather than being trusted. */
export function parseCheckinPayload(raw: unknown): CheckinResult {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'UNKNOWN' };
  const o = raw as Record<string, unknown>;
  const code = String(o.code ?? '');
  if (!KNOWN.has(code)) return { ok: false, code: 'UNKNOWN' };
  if (o.ok === true && (code === 'ALLOCATED' || code === 'ALREADY_ALLOCATED')) {
    if (typeof o.room_code !== 'string' || typeof o.exam_date !== 'string' || (o.session !== 'FN' && o.session !== 'AN')) {
      return { ok: false, code: 'UNKNOWN' };
    }
    return {
      ok: true, code,
      employee_id: String(o.employee_id ?? ''), employee_name: (o.employee_name as string | null) ?? null,
      department: (o.department as string | null) ?? null, exam_date: o.exam_date, session: o.session,
      room_code: o.room_code, building: (o.building as string | null) ?? null, floor: (o.floor as string | null) ?? null,
      round: Number(o.round ?? 0), allocated_at: String(o.allocated_at ?? ''), reference: String(o.reference ?? ''),
    };
  }
  if (o.ok === false) {
    return { ok: false, code: code as Exclude<CheckinCode, 'ALLOCATED' | 'ALREADY_ALLOCATED'>,
      reference: typeof o.reference === 'string' ? o.reference : undefined };
  }
  return { ok: false, code: 'UNKNOWN' };
}

export interface RetryOptions {
  /** how many EXTRA attempts after a BUSY answer (default 4 -> at most 5 calls) */
  maxBusyRetries?: number;
  /** extra attempts after a network failure (default 2) */
  maxNetworkRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; reason: 'BUSY' | 'NETWORK'; delayMs: number }) => void;
}

export const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });

/** Exponential backoff with jitter: delay = random(0.5..1.0) * min(max, base * 2^n). Bounded; never an open-ended loop. */
export function backoffDelay(n: number, base: number, max: number, rnd: () => number): number {
  return Math.round((0.5 + 0.5 * rnd()) * Math.min(max, base * 2 ** n));
}

/**
 * Calls the check-in RPC. Retrying is SAFE: the database is idempotent per employee and session.
 * BUSY and transport failures are retried a bounded number of times; every other answer is returned immediately.
 */
export async function checkinWithRetry(
  call: () => Promise<unknown>,
  opts: RetryOptions = {},
): Promise<{ result: CheckinResult; attempts: number }> {
  const maxBusy = opts.maxBusyRetries ?? 4;
  const maxNet = opts.maxNetworkRetries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  const cap = opts.maxDelayMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;
  const rnd = opts.random ?? Math.random;
  let busy = 0;
  let net = 0;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let result: CheckinResult;
    try {
      result = parseCheckinPayload(await call());
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      const isNet = e instanceof ApiError ? e.isNetwork : true;
      if (isNet && net < maxNet) {
        const delayMs = backoffDelay(net, base, cap, rnd);
        net += 1;
        opts.onRetry?.({ attempt: attempts, reason: 'NETWORK', delayMs });
        await sleep(delayMs, opts.signal);
        continue;
      }
      return { result: { ok: false, code: isNet ? 'NETWORK' : 'UNKNOWN' }, attempts };
    }
    if (!result.ok && result.code === 'BUSY' && busy < maxBusy) {
      const delayMs = backoffDelay(busy, base, cap, rnd);
      busy += 1;
      opts.onRetry?.({ attempt: attempts, reason: 'BUSY', delayMs });
      await sleep(delayMs, opts.signal);
      continue;
    }
    return { result, attempts };
  }
}

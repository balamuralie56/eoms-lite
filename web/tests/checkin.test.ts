import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, checkinWithRetry, describeOutcome, parseCheckinPayload } from '../src/lib/checkin';
import { ApiError } from '../src/lib/rpc';
import type { CheckinResult } from '../src/lib/types';

const cfg = { contact_instructions: 'Visit Room 12, Admin Block.', exam_cell_name: 'Exam Cell' };
const alloc = {
  ok: true, code: 'ALLOCATED', employee_id: 'E1', employee_name: 'Asha Rao', department: 'Physics', exam_date: '2026-11-03', session: 'FN',
  room_code: 'A101', building: 'Main', floor: '1', round: 1, allocated_at: '2026-11-03T03:00:00Z', reference: 'AB12CD34',
};

describe('describeOutcome', () => {
  const codes: Array<CheckinResult> = [
    parseCheckinPayload(alloc),
    parseCheckinPayload({ ...alloc, code: 'ALREADY_ALLOCATED' }),
    ...(['NOT_SCHEDULED', 'NO_ACTIVE_SESSION', 'ROOMS_FULL', 'VERIFICATION_REQUIRED', 'REENTRY_REQUIRES_ADMIN', 'RATE_LIMITED', 'INVALID_ID', 'BUSY'] as const)
      .map((code) => parseCheckinPayload({ ok: false, code, message: 'INTERNAL DETAIL', reference: code === 'VERIFICATION_REQUIRED' ? 'REF12345' : undefined })),
    { ok: false, code: 'NETWORK' }, { ok: false, code: 'UNKNOWN' },
  ];

  it('has a clear title and body for every database and client result code', () => {
    expect(codes).toHaveLength(12);
    for (const r of codes) {
      const o = describeOutcome(r, cfg);
      expect(o.title.length).toBeGreaterThan(5);
      expect(o.body.length).toBeGreaterThan(10);
      expect(['success', 'info', 'warning', 'error']).toContain(o.tone);
    }
  });

  it('points rejected employees at the examination cell using the configured contact text', () => {
    for (const code of ['ROOMS_FULL', 'VERIFICATION_REQUIRED', 'REENTRY_REQUIRES_ADMIN'] as const) {
      expect(describeOutcome({ ok: false, code }, cfg).body).toContain('Visit Room 12, Admin Block.');
    }
  });

  it('never repeats server-supplied messages or internal reasons to the employee', () => {
    for (const r of codes) {
      const text = JSON.stringify(describeOutcome(r, cfg));
      expect(text).not.toContain('INTERNAL DETAIL');
    }
  });

  it('does not reveal whether an arbitrary Employee ID exists', () => {
    const o = describeOutcome({ ok: false, code: 'NOT_SCHEDULED' }, cfg);
    expect(o.title + o.body).not.toMatch(/does not exist|unknown employee|no such/i);
  });
});

describe('parseCheckinPayload', () => {
  it('accepts a well-formed allocation', () => {
    const r = parseCheckinPayload(alloc);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.room_code).toBe('A101');
  });
  it('turns anything unexpected into UNKNOWN instead of trusting it', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { ok: true, code: 'HACKED' }, { ok: true, code: 'ALLOCATED' }, { ok: true, code: 'ALLOCATED', room_code: 5 }]) {
      const r = parseCheckinPayload(bad);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('UNKNOWN');
    }
  });
  it('keeps the verification reference for flagged employees', () => {
    const r = parseCheckinPayload({ ok: false, code: 'VERIFICATION_REQUIRED', reference: 'REF12345' });
    expect(r.ok === false && r.reference).toBe('REF12345');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially with jitter and is capped', () => {
    expect(backoffDelay(0, 400, 5000, () => 1)).toBe(400);
    expect(backoffDelay(0, 400, 5000, () => 0)).toBe(200);
    expect(backoffDelay(3, 400, 5000, () => 1)).toBe(3200);
    expect(backoffDelay(10, 400, 5000, () => 1)).toBe(5000);
    expect(backoffDelay(10, 400, 5000, () => 0)).toBe(2500);
  });
});

describe('checkinWithRetry', () => {
  const noSleep = () => Promise.resolve();
  const busy = { ok: false, code: 'BUSY' };

  it('returns immediately for every non-BUSY answer, without retrying', async () => {
    for (const payload of [alloc, { ok: false, code: 'NOT_SCHEDULED' }, { ok: false, code: 'ROOMS_FULL' }, { ok: false, code: 'RATE_LIMITED' }]) {
      const call = vi.fn().mockResolvedValue(payload);
      const { attempts } = await checkinWithRetry(call, { sleep: noSleep });
      expect(attempts).toBe(1);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it('retries BUSY a bounded number of times then gives up with BUSY (no endless loop)', async () => {
    const call = vi.fn().mockResolvedValue(busy);
    const { result, attempts } = await checkinWithRetry(call, { sleep: noSleep, maxBusyRetries: 4 });
    expect(attempts).toBe(5);
    expect(call).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ ok: false, code: 'BUSY' });
  });

  it('waits exponentially longer between BUSY retries (with jitter) and reports each retry', async () => {
    const delays: number[] = [];
    const call = vi.fn().mockResolvedValue(busy);
    await checkinWithRetry(call, { sleep: async (ms) => { delays.push(ms); }, random: () => 1, baseDelayMs: 400, maxBusyRetries: 4 });
    expect(delays).toEqual([400, 800, 1600, 3200]);
    const seen: string[] = [];
    await checkinWithRetry(vi.fn().mockResolvedValue(busy), { sleep: noSleep, onRetry: (i) => seen.push(i.reason), maxBusyRetries: 2 });
    expect(seen).toEqual(['BUSY', 'BUSY']);
  });

  it('stops retrying as soon as BUSY clears and returns the allocation', async () => {
    const call = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(busy).mockResolvedValueOnce(alloc);
    const { result, attempts } = await checkinWithRetry(call, { sleep: noSleep });
    expect(attempts).toBe(3);
    expect(result.ok).toBe(true);
  });

  it('retries transport failures a bounded number of times, then reports NETWORK', async () => {
    const call = vi.fn().mockRejectedValue(new ApiError('Failed to fetch', '', 0));
    const { result, attempts } = await checkinWithRetry(call, { sleep: noSleep, maxNetworkRetries: 2 });
    expect(attempts).toBe(3);
    expect(result).toMatchObject({ ok: false, code: 'NETWORK' });
  });

  it('does not retry a server-side (non-network) error', async () => {
    const call = vi.fn().mockRejectedValue(new ApiError('boom', 'XX000', 500));
    const { result, attempts } = await checkinWithRetry(call, { sleep: noSleep });
    expect(attempts).toBe(1);
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN' });
  });

  it('can be cancelled', async () => {
    const ctl = new AbortController();
    const call = vi.fn().mockResolvedValue(busy);
    const p = checkinWithRetry(call, {
      signal: ctl.signal,
      sleep: (_ms, sig) => new Promise((_, reject) => { sig?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); ctl.abort(); }),
    });
    await expect(p).rejects.toThrow('aborted');
    expect(call).toHaveBeenCalledTimes(1);
  });
});

// COMPONENT tests: React Testing Library + jsdom with a MOCKED API layer. They verify UI behaviour, not the backend.
// Real-stack behaviour is covered by the Playwright suite (e2e/) and the database/API suites.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = vi.hoisted(() => ({
  status: vi.fn(), checkin: vi.fn(), publicConfig: vi.fn(), isAdmin: vi.fn(), listSessions: vi.fn(),
}));
vi.mock('../src/lib/api', () => ({ api }));

const slip = vi.hoisted(() => ({ renderSlipCanvas: vi.fn(), canvasToPngBlob: vi.fn(), downloaded: [] as string[] }));
vi.mock('../src/lib/slip', async (orig) => {
  const real = await orig<typeof import('../src/lib/slip')>();
  return { ...real, renderSlipCanvas: slip.renderSlipCanvas, canvasToPngBlob: slip.canvasToPngBlob };
});
vi.mock('../src/lib/csv', async (orig) => {
  const real = await orig<typeof import('../src/lib/csv')>();
  return { ...real, downloadBlob: (_b: Blob, name: string) => { slip.downloaded.push(name); } };
});

const auth = vi.hoisted(() => ({ state: 'admin' as string, email: 'boss@example.test' as string | null }));
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ state: auth.state, email: auth.email, notice: null, signIn: vi.fn(), signOut: vi.fn(), handleError: vi.fn(), clearNotice: vi.fn() }),
  AuthProvider: ({ children }: { children: unknown }) => children,
}));

import CheckIn from '../src/pages/public/CheckIn';
import AdminGate from '../src/components/layout/AdminGate';

const alloc = {
  ok: true, code: 'ALLOCATED', employee_id: 'E1', employee_name: 'Asha Rao', department: 'Physics', exam_date: '2026-11-03', session: 'FN',
  room_code: 'A101', building: 'Main Block', floor: '2', round: 1, allocated_at: '2026-11-03T03:00:00Z', reference: 'AB12CD34',
};
const open = { state: 'OPEN', server_time: '2026-11-03T03:00:00Z', exam_date: '2026-11-03', session: 'FN', checkin_closes_at: '2026-11-03T05:00:00Z' };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.status.mockResolvedValue(open);
  api.publicConfig.mockResolvedValue({});
  slip.downloaded.length = 0;
  slip.renderSlipCanvas.mockReset();
  slip.canvasToPngBlob.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const submitId = async (user: ReturnType<typeof userEvent.setup>, id: string) => {
  await user.type(screen.getByTestId('employee-id'), id);
  await user.click(screen.getByTestId('submit-checkin'));
};

describe('public check-in page', () => {
  it('shows the server-side session status and the closing time', async () => {
    render(<CheckIn />);
    expect(await screen.findByTestId('status-open')).toHaveTextContent(/Check-in is open/);
    expect(screen.getByTestId('status-open')).toHaveTextContent(/Tue, 3 Nov 2026/);
    expect(screen.getByTestId('status-open')).toHaveTextContent(/Forenoon \(FN\)/);
    expect(screen.getByTestId('status-open')).toHaveTextContent(/Closes at 10:30 am IST/);
  });

  it('shows a closed banner when no session is open', async () => {
    api.status.mockResolvedValue({ state: 'CLOSED', server_time: 'x' });
    render(<CheckIn />);
    expect(await screen.findByTestId('status-closed')).toBeInTheDocument();
  });

  it('still lets people try to check in when the status call fails', async () => {
    api.status.mockRejectedValue(new Error('down'));
    render(<CheckIn />);
    expect(await screen.findByText(/Could not check the session status/)).toBeInTheDocument();
    expect(screen.getByTestId('submit-checkin')).toBeEnabled();
  });

  it('validates the Employee ID on the client without calling the server', async () => {
    const user = userEvent.setup();
    render(<CheckIn />);
    await user.click(screen.getByTestId('submit-checkin'));
    expect(await screen.findByText('Please enter your Employee ID.')).toBeInTheDocument();
    await user.type(screen.getByTestId('employee-id'), 'bad id!');
    await user.click(screen.getByTestId('submit-checkin'));
    expect(await screen.findByText(/letters, digits/)).toBeInTheDocument();
    expect(api.checkin).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_SCHEDULED', /No duty found/], ['NO_ACTIVE_SESSION', /not open right now/], ['ROOMS_FULL', /All rooms are currently full/],
    ['VERIFICATION_REQUIRED', /Verification required/], ['REENTRY_REQUIRES_ADMIN', /earlier allocation was released/],
    ['RATE_LIMITED', /Too many attempts/], ['INVALID_ID', /valid Employee ID/],
  ])('renders the %s result in plain language', async (code, text) => {
    api.checkin.mockResolvedValue({ ok: false, code, message: 'SECRET INTERNAL REASON', reference: 'REF12345' });
    const user = userEvent.setup();
    render(<CheckIn />);
    await submitId(user, 'E1');
    const box = await screen.findByTestId('result-message');
    expect(box).toHaveTextContent(text);
    expect(box).toHaveAttribute('data-code', code);
    expect(box).not.toHaveTextContent('SECRET INTERNAL REASON');
    expect(api.checkin).toHaveBeenCalledTimes(1);
  });

  it('shows the verification reference but never the internal reason', async () => {
    api.checkin.mockResolvedValue({ ok: false, code: 'VERIFICATION_REQUIRED', reference: 'REF12345' });
    const user = userEvent.setup();
    render(<CheckIn />);
    await submitId(user, 'E1');
    expect(await screen.findByTestId('result-message')).toHaveTextContent('Reference: REF12345');
  });

  it('retries BUSY a bounded number of times (5 calls at most) and then explains', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.checkin.mockResolvedValue({ ok: false, code: 'BUSY' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckIn />);
    await submitId(user, 'E1');
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(await screen.findByTestId('result-message')).toHaveTextContent(/system is busy/i);
    expect(api.checkin).toHaveBeenCalledTimes(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.checkin).toHaveBeenCalledTimes(5);                              // no runaway loop
  });

  it('succeeds after BUSY clears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.checkin.mockResolvedValueOnce({ ok: false, code: 'BUSY' }).mockResolvedValueOnce(alloc);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CheckIn />);
    await submitId(user, 'E1');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(await screen.findByTestId('result-success')).toBeInTheDocument();
    expect(api.checkin).toHaveBeenCalledTimes(2);
  });

  it('shows a prominent room, every required detail, a slip download and a way back', async () => {
    api.checkin.mockResolvedValue(alloc);
    const user = userEvent.setup();
    render(<CheckIn />);
    await submitId(user, 'e1');
    const ok = await screen.findByTestId('result-success');
    expect(screen.getByTestId('room-code')).toHaveTextContent('A101');
    for (const t of ['Asha Rao', 'E1', 'Physics', 'Tue, 3 Nov 2026', 'Forenoon (FN)', 'AB12CD34', 'Main Block · Floor 2']) expect(ok).toHaveTextContent(t);
    expect(screen.getByTestId('download-slip')).toBeEnabled();
    expect(api.checkin).toHaveBeenCalledWith('e1');                            // normalised by the database, not here
  });

  it('"Back to check-in" returns to the form WITHOUT calling the server again', async () => {
    api.checkin.mockResolvedValue(alloc);
    const user = userEvent.setup();
    render(<CheckIn />);
    await submitId(user, 'E1');
    await screen.findByTestId('result-success');
    await user.click(screen.getByTestId('back-to-checkin'));
    expect(await screen.findByTestId('employee-id')).toHaveValue('');
    expect(api.checkin).toHaveBeenCalledTimes(1);
  });

  it('shows an existing allocation as "already checked in" and says nothing changed', async () => {
    api.checkin.mockResolvedValue({ ...alloc, code: 'ALREADY_ALLOCATED' });
    const user = userEvent.setup();
    render(<CheckIn />);
    await submitId(user, 'E1');
    const ok = await screen.findByTestId('result-success');
    expect(ok).toHaveAttribute('data-code', 'ALREADY_ALLOCATED');
    expect(ok).toHaveTextContent(/already checked in/);
    expect(ok).toHaveTextContent(/has not changed/);
  });

  it('downloads the slip with a descriptive file name and shows a save-by-long-press preview', async () => {
    api.checkin.mockResolvedValue(alloc);
    slip.renderSlipCanvas.mockResolvedValue({});
    slip.canvasToPngBlob.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    const user = userEvent.setup();
    render(<CheckIn />);
    await submitId(user, 'E1');
    await user.click(await screen.findByTestId('download-slip'));
    await waitFor(() => expect(slip.downloaded).toEqual(['allocation-slip_E1_2026-11-03_FN.png']));
    expect(await screen.findByAltText(/Allocation slip for room A101/)).toBeInTheDocument();
    expect(slip.renderSlipCanvas).toHaveBeenCalledWith(expect.objectContaining({ room_code: 'A101' }), expect.anything());
  });

  it('reports a slip failure instead of failing silently', async () => {
    api.checkin.mockResolvedValue(alloc);
    slip.renderSlipCanvas.mockRejectedValue(new Error('Canvas is not available in this browser'));
    const user = userEvent.setup();
    render(<CheckIn />);
    await submitId(user, 'E1');
    await user.click(await screen.findByTestId('download-slip'));
    expect(await screen.findByText(/Canvas is not available/)).toBeInTheDocument();
  });

  it('does not store the employee or allocation anywhere in the browser', async () => {
    api.checkin.mockResolvedValue(alloc);
    const user = userEvent.setup();
    render(<CheckIn />);
    await submitId(user, 'E1');
    await screen.findByTestId('result-success');
    expect(JSON.stringify({ ...localStorage })).not.toMatch(/Asha|E1|A101/);
    expect(JSON.stringify({ ...sessionStorage })).not.toMatch(/Asha|E1|A101/);
  });
});

describe('admin route guard (a convenience: the database is the real control)', () => {
  const renderAt = (path = '/admin') => render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/login" element={<p>LOGIN PAGE</p>} />
        <Route path="/admin" element={<AdminGate />}><Route index element={<p>SECRET DASHBOARD</p>} /></Route>
      </Routes>
    </MemoryRouter>);

  beforeEach(() => { api.listSessions.mockResolvedValue([]); });

  it('shows a spinner while the session is being checked', () => {
    auth.state = 'loading';
    renderAt();
    expect(screen.getByText(/Checking your session/)).toBeInTheDocument();
    expect(screen.queryByText('SECRET DASHBOARD')).toBeNull();
  });
  it('redirects signed-out visitors to the login page and renders nothing protected', () => {
    auth.state = 'signedOut';
    renderAt();
    expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument();
    expect(screen.queryByText('SECRET DASHBOARD')).toBeNull();
  });
  it('shows an unauthorized screen to a signed-in user who is not an active admin', () => {
    auth.state = 'notAdmin'; auth.email = 'nobody@example.test';
    renderAt();
    expect(screen.getByText('No administrator access')).toBeInTheDocument();
    expect(screen.getByText(/nobody@example.test/)).toBeInTheDocument();
    expect(screen.queryByText('SECRET DASHBOARD')).toBeNull();
  });
  it('renders the portal with the admin identity and every navigation entry for an admin', async () => {
    auth.state = 'admin'; auth.email = 'boss@example.test';
    renderAt();
    expect(await screen.findByText('SECRET DASHBOARD')).toBeInTheDocument();
    expect(screen.getAllByTestId('admin-identity')[0]).toHaveTextContent('boss@example.test');
    for (const label of ['Dashboard', 'Sessions', 'Rooms', 'Schedule', 'Allocations', 'Verification', 'Audit log', 'Reports', 'Settings']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
  });
});

import { expect, test, type Page } from '@playwright/test';
import { checkInAs, checkinSql, createAdmin, istDate, loginAs, resetDb, seed, sql } from './helpers';

test.beforeEach(async () => { await resetDb(); await createAdmin(); });

const go = async (page: Page, link: string, heading: string) => {
  await page.getByRole('link', { name: link, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
};

test('sessions: create in IST, overlap refused, edit, deactivate with a mandatory reason, reactivate', async ({ page }) => {
  const d1 = await istDate(1);
  await loginAs(page);
  await go(page, 'Sessions', 'Examination sessions');
  await expect(page.getByText('No sessions', { exact: true })).toBeVisible();

  const create = async (label: string, opens: string, closes: string) => {
    await page.getByTestId('new-session').click();
    await page.getByLabel('Examination date').fill(d1);
    await page.getByLabel('Session', { exact: true }).selectOption(label);
    await page.getByLabel('Check-in opens (IST)').fill(`${d1}T${opens}`);
    await page.getByLabel('Check-in closes (IST)').fill(`${d1}T${closes}`);
    await page.getByRole('button', { name: 'Create session' }).click();
  };

  await create('FN', '07:30', '10:00');
  await expect(page.getByRole('cell', { name: 'Forenoon (FN)' })).toBeVisible();
  const stored = (await sql<{ o: string; c: string }>(
    `select to_char(checkin_opens_at at time zone 'UTC', 'HH24:MI') o, to_char(checkin_closes_at at time zone 'UTC', 'HH24:MI') c from exam_sessions`))[0];
  expect(stored).toEqual({ o: '02:00', c: '04:30' });              // 07:30 / 10:00 IST are 02:00 / 04:30 UTC

  await create('AN', '08:00', '12:00');                              // overlaps the FN window
  await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: 'overlaps another active session' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  expect((await sql('select 1 from exam_sessions')).length).toBe(1);

  await create('AN', '13:00', '15:00');
  await expect(page.getByRole('cell', { name: 'Afternoon (AN)' })).toBeVisible();

  // edit the closing time of FN
  await page.getByRole('button', { name: new RegExp(`Edit session ${d1} FN`) }).click();
  await page.getByLabel('Check-in closes (IST)').fill(`${d1}T10:30`);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('row', { name: /Forenoon/ })).toContainText('10:30 am');

  // deactivate: the confirm button stays disabled until a reason is given
  await page.getByRole('button', { name: new RegExp(`Deactivate session ${d1} FN`) }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('button', { name: 'Deactivate', exact: true })).toBeDisabled();
  await dlg.getByLabel('Reason').fill('Paper postponed');
  await dlg.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(page.getByRole('row', { name: /Forenoon/ })).toContainText('Inactive');
  const audit = await sql<{ action: string; after: { reason?: string } }>(`select action, after from audit_log where action = 'session.deactivate'`);
  expect(audit).toHaveLength(1);
  expect(audit[0].after.reason).toBe('Paper postponed');

  await page.getByRole('button', { name: new RegExp(`Activate session ${d1} FN`) }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Back on');
  await page.getByRole('dialog').getByRole('button', { name: 'Activate', exact: true }).click();
  await expect(page.getByRole('row', { name: /Forenoon/ })).not.toContainText('Inactive');
});

test('sessions with allocations: deactivation warns, keeps allocations and closes check-in; date/session are locked', async ({ page }) => {
  const s = await seed({ caps: [2], employees: 3 });
  expect((await checkinSql('E0001')).code).toBe('ALLOCATED');
  await loginAs(page);
  await go(page, 'Sessions', 'Examination sessions');

  await page.getByRole('button', { name: new RegExp(`Edit session ${s.examDate} FN`) }).click();
  await expect(page.getByLabel('Examination date')).toBeDisabled();
  await expect(page.getByLabel('Session', { exact: true })).toBeDisabled();
  await expect(page.getByText(/already reference this session/)).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: new RegExp(`Deactivate session ${s.examDate} FN`) }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('1 active allocations');
  await dlg.getByLabel('Reason').fill('Exam cancelled');
  await dlg.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(page.getByRole('row', { name: /Forenoon/ })).toContainText('Inactive');

  expect((await sql(`select 1 from allocations where released_at is null`)).length).toBe(1);   // untouched
  await checkInAs(page, 'E0002');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'NO_ACTIVE_SESSION');
});

test('rooms: create, duplicate refused, assign with per-session capacity, edit capacity, protect allocated rooms', async ({ page }) => {
  const s = await seed({ caps: [], employees: 4 });
  await loginAs(page);
  await go(page, 'Rooms', 'Rooms');
  await expect(page.getByText('No rooms assigned yet')).toBeVisible();

  const newRoom = async (code: string) => {
    await page.getByTestId('new-room').click();
    await page.getByLabel('Room code').fill(code);
    await page.getByLabel('Building').fill('Main Block');
    await page.getByLabel('Floor').fill('1');
    await page.getByRole('button', { name: 'Create room' }).click();
  };
  await newRoom('a101');
  await expect(page.getByRole('table', { name: 'All rooms' }).getByRole('cell', { name: 'A101', exact: true })).toBeVisible();
  await newRoom('A101');
  await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: 'already exists' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  expect((await sql('select room_code from rooms')).map((r) => r.room_code)).toEqual(['A101']);

  await page.getByTestId('assign-room').click();
  await page.getByLabel('Maximum invigilators for this session').fill('2');
  await page.getByRole('dialog').getByRole('button', { name: 'Assign room' }).click();
  const sess = page.getByRole('table', { name: 'Rooms assigned to the session' });
  await expect(sess.getByRole('row', { name: /A101/ })).toContainText('Available');

  await page.getByRole('button', { name: 'Edit capacity of A101' }).click();
  await page.getByLabel('Maximum invigilators', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Save capacity' }).click();
  await expect(sess.getByRole('row', { name: /A101/ })).toContainText('3');

  for (const id of ['E0001', 'E0002', 'E0003']) expect((await checkinSql(id)).code).toBe('ALLOCATED');
  expect((await checkinSql('E0004')).code).toBe('ROOMS_FULL');                    // capacity respected
  await page.reload();
  await expect(sess.getByRole('row', { name: /A101/ })).toContainText('Full');

  await page.getByRole('button', { name: 'Edit capacity of A101' }).click();      // reduction below the 3 allocated is refused
  await page.getByLabel('Maximum invigilators', { exact: true }).fill('2');
  await expect(page.getByLabel('Maximum invigilators', { exact: true })).toHaveAttribute('min', '3');
  await page.evaluate(() => (document.getElementById('cap') as HTMLInputElement).removeAttribute('min'));   // bypass the browser hint
  await page.getByRole('button', { name: 'Save capacity' }).click();
  await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: 'cannot reduce capacity' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  expect((await sql<{ m: number }>('select max_invigilators m from session_rooms'))[0].m).toBe(3);

  await page.getByRole('button', { name: 'Remove A101 from this session' }).click();     // has allocation history: refused
  await page.getByRole('dialog').getByLabel('Reason').fill('cleanup');
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: 'allocation history' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Deactivate A101 for this session' }).click();   // allowed, existing allocations stay
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('3');
  await dlg.getByLabel('Reason').fill('Room flooded');
  await dlg.getByRole('button', { name: 'Deactivate', exact: true }).click();
  await expect(sess.getByRole('row', { name: /A101/ })).toContainText('Inactive');
  expect((await sql(`select 1 from allocations where session_id = $1 and released_at is null`, [s.sessionId])).length).toBe(3);
});

test('rooms: editing what existing slips show needs an explicit confirmation', async ({ page }) => {
  await seed({ caps: [2], employees: 1 });
  await checkinSql('E0001');
  await loginAs(page);
  await go(page, 'Rooms', 'Rooms');
  await page.getByRole('button', { name: 'Edit room R1' }).click();
  await page.getByLabel('Room code').fill('R1-RENAMED');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog').getByRole('alert').filter({ hasText: 'active allocations whose slips show' })).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('table', { name: 'All rooms' }).getByRole('cell', { name: 'R1-RENAMED', exact: true })).toBeVisible();
  await checkInAs(page, 'E0001');
  await expect(page.getByTestId('room-code')).toHaveText('R1-RENAMED');                  // the corrected code is what the employee sees
});

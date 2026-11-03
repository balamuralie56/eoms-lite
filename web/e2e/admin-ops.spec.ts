import { expect, test, type Page } from '@playwright/test';
import { checkInAs, checkinSql, createAdmin, loginAs, resetDb, seed, sql } from './helpers';

test.beforeEach(async () => { await resetDb(); await createAdmin(); });

const go = async (page: Page, link: string, heading: string) => {
  await page.getByRole('link', { name: link, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
};
const employeeSees = async (page: Page, id: string) => {
  await checkInAs(page, id);
  const ok = page.getByTestId('result-success');
  const msg = page.getByTestId('result-message');
  await expect(ok.or(msg)).toBeVisible();
  return (await ok.isVisible())
    ? { code: (await ok.getAttribute('data-code'))!, room: (await page.getByTestId('room-code').textContent())!.trim() }
    : { code: (await msg.getAttribute('data-code'))!, room: null };
};
const card = (page: Page, label: string) => page.getByTestId('stat-cards').locator('> div').filter({ has: page.getByText(label, { exact: true }) }).locator('p').nth(1);

test('dashboard shows real numbers, a room monitor with filters, and refreshes by itself', async ({ page }) => {
  const s = await seed({ caps: [2, 1, 3], employees: 10 });
  for (const id of ['E0001', 'E0002', 'E0003']) await checkinSql(id);
  await sql(`insert into employee_flags (session_id, employee_id, reason, created_by) values ($1, 'E0009', 'check', gen_random_uuid())`, [s.sessionId]);
  await loginAs(page);
  await expect(page.getByTestId('dashboard-session')).toContainText('Forenoon (FN)');
  await expect(card(page, 'Scheduled')).toHaveText('10');
  await expect(card(page, 'Allocated')).toHaveText('3');
  await expect(card(page, 'Pending')).toHaveText('7');
  await expect(card(page, 'Flagged')).toHaveText('1');
  await expect(card(page, 'Active rooms')).toHaveText('3');
  await expect(card(page, 'Free slots')).toHaveText('3');
  const table = page.getByRole('table', { name: 'Room allocation monitor' });
  await expect(table.getByRole('row', { name: /^R2/ })).toContainText('Full');
  await expect(table.getByRole('row', { name: /^R2/ })).toContainText('1');
  await expect(table.getByRole('row', { name: /^R3/ })).toContainText('Available');

  await page.getByLabel('Filter by status').selectOption('full');
  await expect(table.getByRole('row')).toHaveCount(2);                       // header + R2
  await page.getByLabel('Filter by status').selectOption('');
  await page.getByLabel('Search rooms').fill('r3');
  await expect(table.getByRole('row')).toHaveCount(2);

  const recent = page.getByRole('table', { name: 'Recent allocations' });
  await expect(recent).toContainText('Employee E0003');

  await checkinSql('E0004');                                                 // new activity appears without a reload (8 s refresh)
  await expect(card(page, 'Allocated')).toHaveText('4', { timeout: 25_000 });
  await expect(card(page, 'Pending')).toHaveText('6');
});

test('late arrival: rejected normally, authorized by an admin with a reason, then allocated through the normal engine', async ({ page, context }) => {
  await seed({ opens: -120, closes: -60, caps: [1], employees: 3 });
  const emp = await context.newPage();
  expect((await employeeSees(emp, 'E0001')).code).toBe('NO_ACTIVE_SESSION');

  await loginAs(page);
  await go(page, 'Verification', 'Verification and exceptions');
  await page.getByRole('tab', { name: 'Late check-in' }).click();
  await page.getByTestId('late-emp').fill('GHOST');
  await page.getByTestId('late-reason').fill('Train delayed');
  await page.getByTestId('late-authorize').click();
  await page.getByRole('dialog', { name: 'Authorize late check-in?' }).getByRole('button', { name: 'Authorize' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not scheduled' })).toBeVisible();      // schedule validation still applies

  await page.getByTestId('late-emp').fill('E0001');
  await page.getByTestId('late-authorize').click();
  await page.getByRole('dialog', { name: 'Authorize late check-in?' }).getByRole('button', { name: 'Authorize' }).click();
  await expect(page.getByRole('table', { name: 'Authorizations' }).getByRole('row', { name: /E0001/ })).toContainText('Waiting for employee');

  const seen = await employeeSees(emp, 'E0001');
  expect(seen).toEqual({ code: 'ALLOCATED', room: 'R1' });
  await page.getByRole('combobox', { name: 'Authorization status' }).selectOption('consumed');
  await expect(page.getByRole('table', { name: 'Authorizations' }).getByRole('row', { name: /E0001/ })).toContainText('Used');
  expect((await sql<{ source: string }>(`select source from allocations where employee_id = 'E0001'`))[0].source).toBe('admin_late');

  await page.getByRole('combobox', { name: 'Authorization status' }).selectOption('');             // back to all statuses
  // the permit was one-time, and capacity still applies: a second late employee finds the only room full
  await page.getByTestId('late-emp').fill('E0002');
  await page.getByTestId('late-reason').fill('Second late arrival');
  await page.getByTestId('late-authorize').click();
  await page.getByRole('dialog', { name: 'Authorize late check-in?' }).getByRole('button', { name: 'Authorize' }).click();
  await expect(page.getByRole('table', { name: 'Authorizations' }).getByText('Waiting for employee')).toBeVisible();
  expect((await employeeSees(emp, 'E0002')).code).toBe('ROOMS_FULL');
  expect((await sql(`select 1 from allocations where employee_id = 'E0002'`)).length).toBe(0);
  expect((await sql(`select 1 from audit_log where action = 'authorization.late'`)).length).toBe(2);
});

test('verification: flag, clear, block; the public page never shows the internal reason', async ({ page, context }) => {
  await seed({ caps: [3], employees: 3 });
  const emp = await context.newPage();
  await loginAs(page);
  await go(page, 'Verification', 'Verification and exceptions');

  const flag = async (id: string, reason: string) => {
    await page.getByTestId('flag-employee').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Employee ID').fill(id);
    await dlg.getByLabel('Reason (internal)').fill(reason);
    await dlg.getByRole('button', { name: 'Flag employee' }).click();
  };
  await flag('E0001', 'Photo does not match ID card');
  const row1 = page.getByRole('table', { name: 'Flagged employees' }).getByRole('row', { name: /E0001/ });
  await expect(row1).toContainText('Pending');
  const ref = (await row1.locator('span.font-mono').textContent())!.replace('Ref', '').trim();

  const blocked = await employeeSees(emp, 'E0001');
  expect(blocked.code).toBe('VERIFICATION_REQUIRED');
  await expect(emp.getByTestId('result-message')).toContainText(`Reference: ${ref}`);
  await expect(emp.locator('body')).not.toContainText('Photo does not match');

  await row1.getByRole('button', { name: 'Clear flag for E0001' }).click();
  const dlg = page.getByRole('dialog', { name: 'Clear flag for E0001?' });
  await expect(dlg.getByRole('button', { name: 'Clear flag' })).toBeDisabled();
  await dlg.getByLabel('Resolution note').fill('Identity confirmed at the desk');
  await dlg.getByRole('button', { name: 'Clear flag' }).click();
  await expect(page.getByRole('table', { name: 'Flagged employees' })).toHaveCount(0);        // no open flags left
  expect((await employeeSees(emp, 'E0001')).code).toBe('ALLOCATED');

  await flag('E0002', 'Duplicate claim');
  await page.getByRole('button', { name: 'Block E0002' }).click();
  await page.getByRole('dialog', { name: 'Block E0002?' }).getByLabel('Resolution note').fill('Not permitted to invigilate');
  await page.getByRole('dialog', { name: 'Block E0002?' }).getByRole('button', { name: 'Block employee' }).click();
  await expect(page.getByRole('row', { name: /E0002/ })).toContainText('Blocked');
  expect((await employeeSees(emp, 'E0002')).code).toBe('VERIFICATION_REQUIRED');

  await page.getByRole('combobox', { name: 'Flag status' }).selectOption('cleared');            // verification history
  await expect(page.getByRole('row', { name: /E0001/ })).toContainText('Identity confirmed at the desk');
  const actions = (await sql<{ action: string }>(`select action from audit_log where action like 'flag.%' order by id`)).map((r) => r.action);
  expect(actions).toEqual(['flag.create', 'flag.resolve', 'flag.create', 'flag.resolve']);
});

test('release then re-entry: the employee cannot silently come back; an admin authorization lets the engine allocate again', async ({ page, context }) => {
  await seed({ caps: [2, 2], employees: 2 });
  await checkinSql('E0001');
  const emp = await context.newPage();
  await loginAs(page);
  await go(page, 'Allocations', 'Allocations');
  await page.getByTestId('alloc-search').fill('E0001');
  const table = page.getByRole('table', { name: 'Allocations' });
  await expect(table.getByRole('row', { name: /E0001/ })).toContainText('Active');

  await page.getByRole('button', { name: 'Release E0001' }).click();
  const rel = page.getByRole('dialog', { name: /Release/ });
  await expect(rel.getByRole('button', { name: 'Release allocation' })).toBeDisabled();
  await rel.getByLabel('Reason').fill('Employee fell ill');
  await rel.getByRole('button', { name: 'Release allocation' }).click();
  await expect(table).toHaveCount(0);                                                             // gone from the "Active" list

  expect((await employeeSees(emp, 'E0001')).code).toBe('REENTRY_REQUIRES_ADMIN');
  expect((await sql(`select 1 from allocations where released_at is null`)).length).toBe(0);

  await page.getByLabel('State filter').selectOption('released');
  await page.getByRole('button', { name: 'Authorize re-entry for E0001' }).click();
  const re = page.getByRole('dialog', { name: /Authorize re-entry/ });
  await re.getByLabel('Reason').fill('Recovered and back on duty');
  await re.getByRole('button', { name: 'Authorize re-entry' }).click();

  const back = await employeeSees(emp, 'E0001');
  expect(back.code).toBe('ALLOCATED');
  await page.getByLabel('State filter').selectOption('all');
  await page.getByRole('button', { name: 'History for E0001' }).first().click();
  const hist = page.getByRole('dialog', { name: /History/ }).getByRole('table', { name: 'Allocation history' });
  await expect(hist.getByRole('row')).toHaveCount(3);                                             // header + ended + current
  await expect(hist).toContainText('Employee fell ill');
  await expect(hist).toContainText('Re-entry (authorized)');
  expect((await sql<{ source: string }>(`select source from allocations where released_at is null`))[0].source).toBe('admin_reentry');
});

test('re-entry workflow on the Verification page finds the released allocation first', async ({ page }) => {
  await seed({ caps: [2], employees: 1 });
  await checkinSql('E0001');
  const [a] = await sql<{ id: string }>(`select id from allocations limit 1`);
  await sql(`update allocations set released_at = now(), release_reason = 'left early' where id = $1`, [a.id]);
  await loginAs(page);
  await go(page, 'Verification', 'Verification and exceptions');
  await page.getByRole('tab', { name: 'Re-entry' }).click();
  await page.getByTestId('reentry-emp').fill('E0001');
  await page.getByRole('button', { name: 'Find released allocation' }).click();
  await expect(page.getByText(/Released allocation found: room R1, reason “left early”/)).toBeVisible();
  await page.getByTestId('reentry-reason').fill('Back on duty');
  await page.getByTestId('reentry-authorize').click();
  await page.getByRole('dialog', { name: 'Authorize re-entry?' }).getByRole('button', { name: 'Authorize' }).click();
  await expect(page.getByRole('table', { name: 'Authorizations' }).getByRole('row', { name: /E0001/ })).toContainText('Waiting for employee');
  expect((await sql<{ kind: string }>('select kind from admin_authorizations'))[0].kind).toBe('reentry');
});

test('reassignment: choose another eligible room with a reason; the employee then sees the corrected room and history is kept', async ({ page, context }) => {
  await seed({ caps: [2, 2], employees: 2 });
  await checkinSql('E0001');
  const before = (await sql<{ room_code: string }>(`select r.room_code from allocations a join session_rooms sr on sr.id = a.session_room_id join rooms r on r.id = sr.room_id`))[0].room_code;
  const other = before === 'R1' ? 'R2' : 'R1';
  const emp = await context.newPage();
  await loginAs(page);
  await go(page, 'Allocations', 'Allocations');
  await page.getByRole('button', { name: 'Move E0001' }).click();
  const dlg = page.getByRole('dialog', { name: /Move/ });
  await expect(dlg.getByRole('button', { name: 'Move employee' })).toBeDisabled();             // needs a room and a reason
  await dlg.getByLabel('New room').selectOption({ label: new RegExp(`^${other} `) as never }).catch(async () => {
    const opt = dlg.getByLabel('New room').locator('option', { hasText: new RegExp(`^${other} `) });
    await dlg.getByLabel('New room').selectOption({ value: (await opt.getAttribute('value'))! });
  });
  await dlg.getByLabel('Reason').fill('Balance the rooms');
  await dlg.getByRole('button', { name: 'Move employee' }).click();
  await expect(page.getByRole('table', { name: 'Allocations' }).getByRole('row', { name: /E0001/ })).toContainText(other);

  expect(await employeeSees(emp, 'E0001')).toEqual({ code: 'ALREADY_ALLOCATED', room: other });
  const rows = await sql<{ source: string; released_at: string | null; release_reason: string | null }>(`select source, released_at, release_reason from allocations order by seq`);
  expect(rows).toHaveLength(2);
  expect(rows[0].release_reason).toBe('reassigned: Balance the rooms');
  expect(rows[1].source).toBe('admin_correction');
});

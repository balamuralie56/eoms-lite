import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { checkInAs, createAdmin, pngSize, resetDb, seed, sql } from './helpers';

test.beforeEach(async () => { await resetDb(); });

/** Console messages that indicate a CSP violation or a runtime error. */
function watchConsole(page: Page) {
  const bad: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || /content security policy/i.test(m.text())) bad.push(m.text()); });
  page.on('pageerror', (e) => bad.push('pageerror: ' + e.message));
  return bad;
}

test('employee checks in, sees the room, and retries return the SAME allocation', async ({ page }) => {
  const bad = watchConsole(page);
  const s = await seed({ caps: [2, 2, 2], employees: 4 });
  await page.goto('/');
  await expect(page.getByTestId('status-open')).toContainText('Check-in is open');
  await expect(page.getByTestId('status-open')).toContainText('Forenoon (FN)');

  await page.getByTestId('employee-id').fill('  e0001 ');
  await page.getByTestId('submit-checkin').click();
  const ok = page.getByTestId('result-success');
  await expect(ok).toBeVisible();
  await expect(ok).toHaveAttribute('data-code', 'ALLOCATED');
  const room = (await page.getByTestId('room-code').textContent())!.trim();
  expect(room).toMatch(/^R[123]$/);
  for (const t of ['Employee E0001', 'E0001', 'Dept 1', 'Forenoon (FN)', 'Main Block']) await expect(ok).toContainText(t);

  // back, then check in again: same room, "already checked in", no second allocation in the database
  await page.getByTestId('back-to-checkin').click();
  await page.getByTestId('employee-id').fill('E0001');
  await page.getByTestId('submit-checkin').click();
  await expect(page.getByTestId('result-success')).toHaveAttribute('data-code', 'ALREADY_ALLOCATED');
  await expect(page.getByTestId('room-code')).toHaveText(room);
  const rows = await sql(`select count(*)::int c from allocations where session_id = $1 and employee_id = 'E0001'`, [s.sessionId]);
  expect(rows[0].c).toBe(1);
  expect(bad, 'no CSP violations or console errors').toEqual([]);
});

test('every database rejection is shown in plain language', async ({ page }) => {
  const s = await seed({ caps: [1], employees: 5 });
  // NOT_SCHEDULED
  await checkInAs(page, 'NOBODY');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'NOT_SCHEDULED');
  await expect(page.getByTestId('result-message')).toContainText('No duty found');
  // INVALID_ID is caught before any request
  await page.getByTestId('employee-id').fill('bad id!');
  await page.getByTestId('submit-checkin').click();
  await expect(page.getByText(/letters, digits/)).toBeVisible();
  // ROOMS_FULL after the only slot is taken
  await checkInAs(page, 'E0001');
  await expect(page.getByTestId('result-success')).toBeVisible();
  await checkInAs(page, 'E0002');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'ROOMS_FULL');
  await expect(page.getByTestId('result-message')).toContainText('currently full');
  expect((await sql(`select count(*)::int c from allocations where session_id = $1`, [s.sessionId]))[0].c).toBe(1);
  // VERIFICATION_REQUIRED never reveals the internal reason
  await sql(`insert into employee_flags (session_id, employee_id, reason, created_by) values ($1, 'E0003', 'TOP SECRET REASON', gen_random_uuid())`, [s.sessionId]);
  await checkInAs(page, 'E0003');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'VERIFICATION_REQUIRED');
  await expect(page.locator('body')).not.toContainText('TOP SECRET REASON');
  // REENTRY_REQUIRES_ADMIN after a release
  await sql(`update allocations set released_at = now(), release_reason = 'test' where employee_id = 'E0001'`);
  await checkInAs(page, 'E0001');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'REENTRY_REQUIRES_ADMIN');
});

test('no active session: the employee cannot check in and is told so (no fallback to another session)', async ({ page }) => {
  await seed({ opens: -120, closes: -60, employees: 2 });
  await page.goto('/');
  await expect(page.getByTestId('status-closed')).toBeVisible();
  await checkInAs(page, 'E0001');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'NO_ACTIVE_SESSION');
  expect((await sql('select count(*)::int c from allocations'))[0].c).toBe(0);
});

test('abuse throttle: repeated failed lookups from one client end in RATE_LIMITED', async ({ page }) => {
  await seed({ employees: 2 });
  await sql(`update app_settings set int_value = 2 where key = 'throttle_max_failures'`);
  await checkInAs(page, 'GHOST1');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'NOT_SCHEDULED');
  await checkInAs(page, 'GHOST2');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'NOT_SCHEDULED');
  await checkInAs(page, 'E0001');
  await expect(page.getByTestId('result-message')).toHaveAttribute('data-code', 'RATE_LIMITED');
  await expect(page.getByTestId('result-message')).toContainText('Too many attempts');
});

test('a PNG slip downloads with the right name, size and visible content', async ({ page }) => {
  await seed({ employees: 1, names: () => 'Dr. Alexandria Montgomery-Featherstonehaugh of the Department of Advanced Computational Physics' });
  await checkInAs(page, 'E0001');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-slip').click()]);
  const examDate = (await sql<{ d: string }>(`select exam_date::text d from schedule limit 1`))[0].d;
  expect(download.suggestedFilename()).toBe(`allocation-slip_E0001_${examDate}_FN.png`);
  const file = await download.path();
  const buf = fs.readFileSync(file!);
  expect(pngSize(buf)).toEqual({ width: 1800, height: 1100 });
  expect(buf.length).toBeGreaterThan(30_000);

  // decode it in the browser and sample pixels: navy header band, white body, dark text somewhere in the body
  const stats = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    const body = ctx.getImageData(80, 320, 700, 520).data;
    let dark = 0; for (let i = 0; i < body.length; i += 4) if (body[i] < 120 && body[i + 1] < 120) dark++;
    const right = ctx.getImageData(840, 330, 880, 560).data;
    let ink = 0; for (let i = 0; i < right.length; i += 4) if (right[i] < 90 && right[i + 1] < 90 && right[i + 2] < 90) ink++;
    // nothing painted over the right frame edge (text must not run out of the page)
    const edge = ctx.getImageData(1740, 300, 30, 600).data;
    let edgeInk = 0; for (let i = 0; i < edge.length; i += 4) if (edge[i] < 90 && edge[i + 1] < 90 && edge[i + 2] < 90) edgeInk++;
    return { header: px(40, 40), page: px(1000, 20), dark, ink, edgeInk };
  }, buf.toString('base64'));
  expect(stats.header).toEqual([30, 58, 138]);        // navy header band
  expect(stats.dark).toBeGreaterThan(5000);           // the large room code was drawn
  expect(stats.ink).toBeGreaterThan(3000);            // employee details were drawn
  expect(stats.edgeInk).toBe(0);                      // the long name/department did not overflow the slip
  // and the on-screen preview (press-and-hold fallback for phones) is shown
  await expect(page.getByAltText(/Allocation slip for room/)).toBeVisible();
});

test('branding configured by the admin appears on the public page', async ({ page }) => {
  await seed({ employees: 1 });
  await sql(`update app_branding set institution_name = 'Greenfield University', exam_cell_name = 'Controller of Examinations', app_title = 'Duty Check-In',
             contact_instructions = 'Visit Room 12, Admin Block.', support_info = 'Help: 0123-456789' where id = 1`);
  await page.goto('/');
  await expect(page.getByText('Greenfield University')).toBeVisible();
  await expect(page.getByText('Controller of Examinations')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Duty Check-In' })).toBeVisible();
  await expect(page.getByText('Help: 0123-456789')).toBeVisible();
  await expect(page).toHaveTitle('Duty Check-In');
  await checkInAs(page, 'GHOST');
  await expect(page.getByTestId('result-message')).toContainText('Visit Room 12, Admin Block.');
});

test('unknown paths show a not-found page and the SPA fallback serves deep links', async ({ page }) => {
  await page.goto('/definitely/not/here');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await createAdmin();
  await page.goto('/admin/schedule');                    // deep link: served by the fallback, then redirected to login
  await expect(page).toHaveURL(/\/admin\/login$/);
});

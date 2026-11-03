import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { checkInAs, createAdmin, loginAs, pngSize, resetDb, seed } from './helpers';

// Runs only in the "mobile" project: 375x667, touch, mobile user agent via Chrome device emulation.
// This is NOT iPhone Safari/WebKit (no WebKit browser is installed here); see docs/TESTING.md.
test.beforeEach(async () => { await resetDb(); });

const overflow = (page: Page) => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));

test('check-in page fits a small phone: no sideways scroll, comfortable touch targets, readable inputs', async ({ page }) => {
  await seed({ employees: 2 });
  await page.goto('/');
  await expect(page.getByTestId('status-open')).toBeVisible();
  const o = await overflow(page);
  expect(o.scroll).toBeLessThanOrEqual(o.inner);
  const btn = await page.getByTestId('submit-checkin').boundingBox();
  expect(btn!.height).toBeGreaterThanOrEqual(44);
  expect(btn!.width).toBeGreaterThan(280);
  const fontSize = await page.getByTestId('employee-id').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);          // iOS Safari zooms into smaller inputs
  const attrs = await page.getByTestId('employee-id').evaluate((el) => ({ ac: el.getAttribute('autocapitalize'), au: el.getAttribute('autocomplete') }));
  expect(attrs).toEqual({ ac: 'characters', au: 'off' });
});

test('allocation screen on a phone: room code prominent and fully visible, slip downloads', async ({ page }) => {
  await seed({ employees: 1, names: () => 'A Very Long Employee Name That Goes On And On Without Any Sensible Ending' });
  await checkInAs(page, 'E0001');
  await expect(page.getByTestId('result-success')).toBeVisible();
  const o = await overflow(page);
  expect(o.scroll).toBeLessThanOrEqual(o.inner);
  const room = await page.getByTestId('room-code').boundingBox();
  expect(room!.x).toBeGreaterThanOrEqual(0);
  expect(room!.x + room!.width).toBeLessThanOrEqual(375);
  expect(room!.height).toBeGreaterThan(40);
  const size = await page.getByTestId('room-code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size).toBeGreaterThanOrEqual(48);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-slip').click()]);
  expect(pngSize(fs.readFileSync((await download.path())!))).toEqual({ width: 1800, height: 1100 });
});

test('rejection messages are readable and do not overflow on a phone', async ({ page }) => {
  await seed({ employees: 1, caps: [1] });
  await checkInAs(page, 'NOBODY');
  await expect(page.getByTestId('result-message')).toBeVisible();
  const o = await overflow(page);
  expect(o.scroll).toBeLessThanOrEqual(o.inner);
});

test('admin portal on a phone: menu opens, navigates, and no admin page scrolls sideways', async ({ page }) => {
  await seed({ employees: 8 });
  await createAdmin();
  await loginAs(page);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const routes: Array<[string, string]> = [['Sessions', 'Examination sessions'], ['Rooms', 'Rooms'], ['Schedule', 'Schedule'], ['Allocations', 'Allocations'],
    ['Verification', 'Verification and exceptions'], ['Audit log', 'Audit log'], ['Reports', 'Reports and exports'], ['Settings', 'Settings'], ['Dashboard', 'Dashboard']];
  for (const [link, heading] of routes) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    const o = await overflow(page);
    expect(o.scroll, `${link} must not scroll the whole page sideways`).toBeLessThanOrEqual(o.inner);
  }
});

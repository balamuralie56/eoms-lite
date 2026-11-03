import fs from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { readSheet } from 'read-excel-file/node';
import { checkInAs, checkinSql, createAdmin, istDate, loginAs, pngSize, resetDb, seed, sql } from './helpers';

test.beforeEach(async () => { await resetDb(); await createAdmin(); });

const go = async (page: Page, link: string, heading: string) => {
  await page.getByRole('link', { name: link, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
};
const read = async (d: Download) => fs.readFileSync((await d.path())!);
const text = async (d: Download) => (await read(d)).toString('utf8');
const parseCsv = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).trim().split('\r\n');

test('audit viewer: filter, search, details, dates and pagination; entries cannot be edited or deleted from the UI', async ({ page }) => {
  await seed({ caps: [10, 10, 10], employees: 30 });
  for (let i = 1; i <= 30; i++) await checkinSql(`E${String(i).padStart(4, '0')}`);
  const today = await istDate(0);
  const tomorrow = await istDate(1);
  await loginAs(page);
  await go(page, 'Audit log', 'Audit log');

  await expect(page.getByText(/Showing 1–25 of 30/)).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText(/Showing 26–30 of 30/)).toBeVisible();
  await page.getByRole('button', { name: 'Previous page' }).click();

  await page.getByLabel('Action filter').selectOption('allocation.create');
  await expect(page.getByText(/of 30/)).toBeVisible();
  await page.getByTestId('audit-search').fill('E0007');
  await expect(page.getByText(/Showing 1–1 of 1/)).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'allocation.create' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: /Show details of entry/ }).click();
  await expect(page.locator('pre').filter({ hasText: 'E0007' })).toBeVisible();      // the "After" JSON of that allocation
  await expect(page.getByText(/Request reference:/)).toBeVisible();

  // read-only: no way to change history
  await expect(page.getByRole('button', { name: /delete|remove|edit|undo|clear/i })).toHaveCount(0);
  await expect(page.getByText(/append-only/)).toBeVisible();

  // export respects the filters (search = E0007 -> exactly one data row)
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-audit-csv').click()]);
  expect(dl.suggestedFilename()).toMatch(/^eoms_audit_allocation\.create_\d{8}-\d{4}\.csv$/);
  const lines = parseCsv(await text(dl));
  expect(lines[0]).toBe('Id,Time (IST),Actor,Admin,Action,Entity,Entity id,Before,After,Request id');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('employee:E0007');

  // date filters (Asia/Kolkata days)
  await page.getByTestId('audit-search').fill('');
  await page.getByLabel('Action filter').selectOption('');
  await page.getByLabel('From (IST date)').fill(tomorrow);
  await expect(page.getByText('No audit entries match')).toBeVisible();
  await page.getByLabel('From (IST date)').fill(today);
  await page.getByLabel('To (IST date, inclusive)').fill(today);
  await expect(page.getByText(/Showing 1–25 of 30/)).toBeVisible();
});

test('reports: every report loads; CSV and XLSX exports match the filters, include date and session, and neutralise formulas', async ({ page }) => {
  const s = await seed({ caps: [2, 1, 3], employees: 10, names: (i) => (i === 0 ? '=HYPERLINK("http://evil.example","click me")' : `Employee ${i + 1}`) });
  for (const id of ['E0001', 'E0002', 'E0003']) await checkinSql(id);
  await sql(`insert into employee_flags (session_id, employee_id, reason, created_by) values ($1, 'E0009', '+cmd|calc', gen_random_uuid())`, [s.sessionId]);
  await loginAs(page);
  await go(page, 'Reports', 'Reports and exports');

  // every report previews without an error
  for (const key of ['session_allocations', 'room_allocations', 'employee_allocations', 'unallocated', 'full_rooms', 'late_checkins', 'verification_exceptions', 'corrections', 'imports']) {
    await page.getByTestId(`report-${key}`).click();
    await expect(page.getByRole('heading', { name: /^Preview/ })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }

  await page.getByTestId('report-session_allocations').click();
  await expect(page.getByRole('heading', { name: 'Preview: 3 rows' })).toBeVisible();

  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  expect(csv.suggestedFilename()).toMatch(new RegExp(`^eoms_session_allocations_${s.examDate}_FN_\\d{8}-\\d{4}\\.csv$`));
  const lines = parseCsv(await text(csv));
  expect(lines[0]).toBe('Exam date,Session,Employee id,Employee name,Department,Room code,Building,Floor,Round,Source,Allocated at (IST)');
  expect(lines).toHaveLength(4);
  const evil = lines.find((l) => l.includes('HYPERLINK'))!;
  expect(evil).toContain(`'=HYPERLINK(`);                                    // neutralised: stored as text, never run as a formula
  expect(lines.every((l) => l.startsWith(s.examDate) || l.startsWith('Exam date'))).toBe(true);
  expect(lines[1]).toContain(',FN,');

  const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-xlsx').click()]);
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  const buf = await read(xlsx);
  expect(buf.subarray(0, 2).toString()).toBe('PK');
  const sheet = (await readSheet(buf)) as unknown[][];
  expect(sheet).toHaveLength(4);
  expect(sheet[0][0]).toBe('Exam date');
  const cells = sheet.flat().map(String);
  expect(cells.some((c) => c.startsWith(`'=HYPERLINK(`))).toBe(true);
  expect(cells.some((c) => c.startsWith('=HYPERLINK('))).toBe(false);

  // the export follows the report and its filters: "unallocated" has the 7 scheduled employees without an allocation
  await page.getByTestId('report-unallocated').click();
  const [un] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  const unLines = parseCsv(await text(un));
  expect(unLines).toHaveLength(8);
  expect(unLines[0]).toBe('Exam date,Session,Employee id,Employee name,Department,Status,Room code,Allocated at (IST)');
  expect(unLines.filter((l) => l.includes(',flagged,'))).toHaveLength(1);
  expect(un.suggestedFilename()).toContain('eoms_unallocated');

  // the verification report neutralises a reason that starts with "+"
  await page.getByTestId('report-verification_exceptions').click();
  const [ver] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  expect(await text(ver)).toContain("'+cmd|calc");

  // an empty result still exports a valid file with the header row
  await page.getByTestId('report-imports').click();
  const [imp] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
  expect(parseCsv(await text(imp))).toHaveLength(1);
});

test('schedule list: pagination, search, and an export that follows the filters', async ({ page }) => {
  await seed({ caps: [5], employees: 60 });
  await loginAs(page);
  await go(page, 'Schedule', 'Schedule');
  await expect(page.getByText(/Showing 1–25 of 60/)).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText(/Showing 26–50 of 60/)).toBeVisible();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText(/Showing 51–60 of 60/)).toBeVisible();
  await page.getByLabel('Search schedule').fill('e0042');
  await expect(page.getByText(/Showing 1–1 of 1/)).toBeVisible();
  await page.getByLabel('Status filter').selectOption('allocated');
  await expect(page.getByText('No matching rows')).toBeVisible();
  await page.getByLabel('Status filter').selectOption('');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-schedule-csv').click()]);
  const lines = parseCsv(await text(dl));
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('E0042');
  expect(dl.suggestedFilename()).toContain('e0042');
});

const png = (w: number, h: number, noise = false) => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) {
    const v = noise ? Math.floor(Math.random() * 256) : 40;
    p.data[i] = v; p.data[i + 1] = noise ? Math.floor(Math.random() * 256) : 90; p.data[i + 2] = noise ? Math.floor(Math.random() * 256) : 160; p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
};

test('settings: branding and logo reach the public page and the slip; invalid logos are refused; changes are audited without the image', async ({ page, context }) => {
  await seed({ employees: 1 });
  await loginAs(page);
  await go(page, 'Settings', 'Settings');
  await page.getByLabel('Institution name').fill('Greenfield University');
  await page.getByLabel('Examination cell name').fill('Controller of Examinations');
  await page.getByLabel('Application title').fill('Duty Check-In');
  await page.getByLabel('Contact instructions').fill('Visit Room 12, Admin Block.');
  await page.getByLabel('Support information').fill('Help desk: 0123-456789');

  await page.getByTestId('logo-file').setInputFiles({ name: 'logo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await expect(page.getByText('PNG, JPEG or WebP image (SVG is not allowed)')).toBeVisible();
  await page.getByTestId('logo-file').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: png(500, 500, true) });
  await expect(page.getByText(/larger than 150 KB/)).toBeVisible();
  await page.getByTestId('logo-file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png(64, 64) });
  await expect(page.getByAltText('Current logo')).toBeVisible();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  const audit = (await sql<{ before: Record<string, unknown>; after: Record<string, unknown> }>(`select before, after from audit_log where action = 'settings.update'`))[0];
  expect(audit.after.institution_name).toBe('Greenfield University');
  expect(audit.before.institution_name).toBe('Your Institution');
  expect(JSON.stringify(audit)).not.toContain('base64');

  const pub = await context.newPage();
  await pub.goto('/');
  await expect(pub.getByText('Greenfield University')).toBeVisible();
  await expect(pub.getByRole('heading', { name: 'Duty Check-In' })).toBeVisible();
  await expect(pub.locator('header img')).toBeVisible();
  await expect(pub.getByText('Help desk: 0123-456789')).toBeVisible();
  await checkInAs(pub, 'E0001');
  const [dl] = await Promise.all([pub.waitForEvent('download'), pub.getByTestId('download-slip').click()]);
  expect(pngSize(await read(dl))).toEqual({ width: 1800, height: 1100 });

  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved').first()).toBeVisible();
  expect((await sql<{ logo_data_url: string | null }>('select logo_data_url from app_branding'))[0].logo_data_url).toBeNull();
});

test('permanent QR code: download is gated on https + verification and the image contains ONLY the public address', async ({ page }) => {
  await seed({ employees: 1 });
  await loginAs(page);
  await go(page, 'Settings', 'Settings');
  const dl = page.getByTestId('qr-download');
  await expect(page.getByText(/local address/)).toBeVisible();
  await expect(dl).toBeDisabled();

  await page.getByLabel('Public check-in address').fill('http://insecure.example');
  await expect(page.getByText('The address must start with https://')).toBeVisible();
  await expect(dl).toBeDisabled();

  const url = 'https://checkin.example.org';
  await page.getByLabel('Public check-in address').fill(url);
  await expect(dl).toBeDisabled();                                       // not yet verified by a person
  await page.getByTestId('qr-verified').check();
  await expect(dl).toBeEnabled();
  const [file] = await Promise.all([page.waitForEvent('download'), dl.click()]);
  expect(file.suggestedFilename()).toBe('eoms-checkin-qr.png');
  const img = PNG.sync.read(await read(file));
  expect(img.width).toBeGreaterThanOrEqual(2000);
  const decoded = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  expect(decoded?.data).toBe(url);                                       // exactly the address: no employee, session, date or token
  expect(decoded!.data).not.toMatch(/[?#]|session|employee|token|E0001/i);

  await page.getByLabel('Public check-in address').fill('https://other.example.org');   // changing the address revokes the verification
  await expect(page.getByTestId('qr-verified')).not.toBeChecked();
  await expect(dl).toBeDisabled();
});

test('maintenance and request-header diagnostics', async ({ page }) => {
  await seed({ employees: 1 });
  await sql(`insert into check_attempts (at, ip_hash, outcome) values (now() - interval '5 days', 'old', 'NOT_SCHEDULED')`);
  await loginAs(page);
  await go(page, 'Settings', 'Settings');
  await page.getByTestId('run-maintenance').click();
  await page.getByRole('dialog', { name: 'Run maintenance?' }).getByRole('button', { name: 'Run maintenance' }).click();
  await expect(page.getByText(/Removed 1 throttle records/)).toBeVisible();
  expect((await sql(`select 1 from audit_log where action = 'maintenance.run'`)).length).toBe(1);
  expect((await sql('select 1 from check_attempts')).length).toBe(0);

  await page.getByRole('button', { name: 'Inspect request headers' }).click();
  const json = page.getByTestId('headers-json');
  await expect(json).toContainText('x-forwarded-for');
  await expect(json).not.toContainText('authorization');                 // credentials are never shown
  await expect(page.getByText('a header was found')).toBeVisible();
});

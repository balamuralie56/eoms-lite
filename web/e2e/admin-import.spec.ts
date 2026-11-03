import { expect, test, type Page } from '@playwright/test';
import writeXlsx from 'write-excel-file/node';
import { createAdmin, istDate, loginAs, resetDb, sql } from './helpers';

const HEADER = ['Employee ID', 'Name', 'Department', 'Examination Date', 'Session'];
const csv = (rows: Array<Array<string | number>>) => Buffer.from([HEADER, ...rows].map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(',')).join('\r\n'));

let D1 = '';          // tomorrow (IST), the date of the two configured sessions

test.beforeEach(async () => {
  await resetDb();
  await createAdmin();
  D1 = await istDate(1);
  for (const [label, from, to] of [['FN', '08:00', '10:00'], ['AN', '13:00', '15:00']]) {
    await sql(`insert into exam_sessions (exam_date, session_label, checkin_opens_at, checkin_closes_at)
               values ($1::date, $2, ($1::date + $3::time) at time zone 'Asia/Kolkata', ($1::date + $4::time) at time zone 'Asia/Kolkata')`, [D1, label, from, to]);
  }
});

async function openWizard(page: Page) {
  await loginAs(page);
  await page.getByRole('link', { name: 'Schedule', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Schedule', exact: true })).toBeVisible();
  await page.getByTestId('open-import').click();
  return page.getByRole('dialog', { name: 'Import schedule' });
}
const upload = async (page: Page, name: string, buffer: Buffer, mimeType = 'text/csv') =>
  page.getByTestId('import-file').setInputFiles({ name, mimeType, buffer });
const stat = (page: Page, label: string) => page.getByTestId('validation-summary').locator('div', { hasText: new RegExp(`^${label}`) }).first().locator('p').nth(1);
const scheduleCount = async () => (await sql<{ c: number }>('select count(*)::int c from schedule'))[0].c;

test('valid CSV: preview, server validation, explicit commit, final report; the live schedule only changes at commit', async ({ page }) => {
  const wiz = await openWizard(page);
  await upload(page, 'november.csv', csv([
    [' emp001 ', 'Asha Rao', 'Physics', D1, 'Forenoon'],
    ['EMP002', 'Ben Joy', 'Maths', D1.split('-').reverse().join('/'), 'AN'],
    ['EMP003', 'Chitra N', 'Chem', D1, 'afternoon'],
    ['EMP004', 'Dev K', 'Bio', `${D1} 00:00:00`, 'fn'],
    ['EMP005', 'Esha P', 'CSE', D1, 'FN'],
  ]));
  await expect(wiz).toContainText('november.csv: 5 data rows read');
  await expect(wiz).toContainText('Nothing has been sent yet');
  expect(await scheduleCount()).toBe(0);

  await page.getByTestId('start-validation').click();
  await expect(page.getByTestId('validation-summary')).toBeVisible();
  await expect(stat(page, 'Valid')).toHaveText('5');
  await expect(stat(page, 'Invalid')).toHaveText('0');
  expect(await scheduleCount()).toBe(0);                       // dry run: nothing in the live schedule yet

  await page.getByTestId('commit-import').click();
  const confirm = page.getByRole('dialog', { name: 'Import these rows?' });
  await expect(confirm).toContainText('5 new schedule rows');
  await confirm.getByRole('button', { name: 'Import 5 rows' }).click();
  await expect(page.getByTestId('import-report')).toContainText('5 rows were added');

  const rows = await sql<{ employee_id: string; employee_name: string; session_label: string }>('select employee_id, employee_name, session_label from schedule order by employee_id');
  expect(rows.map((r) => [r.employee_id, r.session_label])).toEqual([['EMP001', 'FN'], ['EMP002', 'AN'], ['EMP003', 'AN'], ['EMP004', 'FN'], ['EMP005', 'FN']]);
  const batch = (await sql<{ status: string; filename: string; inserted_count: number }>('select status, filename, inserted_count from import_batches'))[0];
  expect(batch).toEqual({ status: 'committed', filename: 'november.csv', inserted_count: 5 });
  expect((await sql(`select 1 from audit_log where action = 'import.commit'`)).length).toBe(1);

  await wiz.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: 'EMP001', exact: true })).toBeVisible();      // the schedule table shows them
  await page.getByRole('tab', { name: 'Import history' }).click();
  await expect(page.getByRole('cell', { name: 'november.csv' })).toBeVisible();
});

test('invalid rows are shown with row numbers and messages and block the whole import', async ({ page }) => {
  const wiz = await openWizard(page);
  await upload(page, 'bad.csv', csv([
    ['E1', 'Good One', 'Physics', D1, 'FN'],
    ['E2', 'Bad Date', 'Physics', '31-02-2027', 'FN'],
    ['E 3', 'Bad Id', 'Physics', D1, 'FN'],
    ['E4', '', 'Physics', D1, 'FN'],
    ['E5', 'No Session Configured', 'Physics', '2031-01-01', 'FN'],
    ['E6', 'Bad Session', 'Physics', D1, 'EVENING'],
  ]));
  await page.getByTestId('start-validation').click();
  await expect(stat(page, 'Valid')).toHaveText('1');
  await expect(stat(page, 'Invalid')).toHaveText('5');
  await expect(wiz).toContainText('Fix the file before importing');
  const table = wiz.getByRole('table', { name: 'Validation results by row' });
  await expect(table.getByRole('row', { name: /Bad Date/ })).toContainText('not a valid date');
  await expect(table.getByRole('row', { name: /Bad Id/ })).toContainText('Employee ID is invalid');
  await expect(table.getByRole('row', { name: /E4/ })).toContainText('Name is missing');
  await expect(table.getByRole('row', { name: /E5/ })).toContainText('No examination session is configured for 2031-01-01 FN');
  await expect(table.getByRole('row', { name: /Bad Session/ })).toContainText('FN, AN, Forenoon or Afternoon');
  await expect(table.getByRole('row', { name: /Bad Date/ }).getByRole('cell').first()).toHaveText('3');     // spreadsheet row number
  await expect(page.getByTestId('commit-import')).toBeDisabled();
  expect(await scheduleCount()).toBe(0);
  await wiz.getByRole('button', { name: 'Cancel import' }).click();
  expect(await scheduleCount()).toBe(0);
  expect((await sql<{ status: string }>('select status from import_batches'))[0].status).toBe('cancelled');
  expect((await sql('select 1 from import_rows')).length).toBe(0);                                          // staging data discarded
});

test('duplicates are skipped, conflicts need an explicit decision, nothing is overwritten unless replacement is separately confirmed', async ({ page }) => {
  await sql(`insert into schedule (employee_id, employee_name, department, exam_date, session_label) values
             ('E1', 'Old Name', 'Physics', $1, 'FN'), ('E2', 'Same Name', 'Maths', $1, 'FN')`, [D1]);
  const wiz = await openWizard(page);
  await upload(page, 'mixed.csv', csv([
    ['E1', 'New Name', 'Physics', D1, 'FN'],        // conflict with the live schedule
    ['E2', 'Same Name', 'Maths', D1, 'FN'],         // exact duplicate of the live schedule
    ['E3', 'Fresh Person', 'Chem', D1, 'FN'],       // new
    ['E3', 'Fresh Person', 'Chem', D1, 'FN'],       // duplicate within the file
  ]));
  await page.getByTestId('start-validation').click();
  await expect(stat(page, 'Valid')).toHaveText('1');
  await expect(stat(page, 'Duplicates')).toHaveText('2');
  await expect(stat(page, 'Conflicts')).toHaveText('1');
  const table = wiz.getByRole('table', { name: 'Validation results by row' });
  await expect(table.getByRole('row', { name: /E1/ })).toContainText('Already scheduled as "Old Name" in "Physics"');
  await expect(wiz).toContainText('1 rows conflict with existing schedule entries');
  await expect(page.getByTestId('commit-import')).toBeDisabled();              // no decision yet

  await page.getByTestId('decision-skip').check();
  await page.getByTestId('commit-import').click();
  await page.getByRole('dialog', { name: 'Import these rows?' }).getByRole('button', { name: /^Import 1 rows$/ }).click();
  await expect(page.getByTestId('import-report')).toContainText('1 rows were added');
  expect((await sql<{ employee_name: string }>(`select employee_name from schedule where employee_id = 'E1'`))[0].employee_name).toBe('Old Name');   // NOT overwritten
  expect(await scheduleCount()).toBe(3);

  await page.getByTestId('replace-conflicts').click();
  const dlg = page.getByRole('dialog', { name: 'Replace conflicting records?' });
  await expect(dlg.getByRole('button', { name: 'Replace records' })).toBeDisabled();       // a reason is mandatory
  await dlg.getByLabel('Reason').fill('HR corrected the name');
  await dlg.getByRole('button', { name: 'Replace records' }).click();
  await expect(page.getByTestId('import-report')).toContainText('Replaced');
  await expect.poll(async () => (await sql<{ employee_name: string }>(`select employee_name from schedule where employee_id = 'E1'`))[0].employee_name).toBe('New Name');
  const aud = await sql<{ before: { employee_name: string }; after: { employee_name: string; reason: string } }>(`select before, after from audit_log where action = 'schedule.replace'`);
  expect(aud).toHaveLength(1);
  expect(aud[0].before.employee_name).toBe('Old Name');
  expect(aud[0].after).toMatchObject({ employee_name: 'New Name', reason: 'HR corrected the name' });
});

test('choosing "abort" on conflicts imports nothing', async ({ page }) => {
  await sql(`insert into schedule (employee_id, employee_name, department, exam_date, session_label) values ('E1', 'Old', 'Physics', $1, 'FN')`, [D1]);
  const wiz = await openWizard(page);
  await upload(page, 'c.csv', csv([['E1', 'New', 'Physics', D1, 'FN'], ['E9', 'Fresh', 'Chem', D1, 'FN']]));
  await page.getByTestId('start-validation').click();
  await page.getByTestId('decision-abort').check();
  await expect(page.getByTestId('commit-import')).toBeDisabled();
  await wiz.getByRole('button', { name: 'Abort import' }).click();
  await expect(wiz).toHaveCount(0);
  expect(await scheduleCount()).toBe(1);
  expect((await sql<{ status: string }>('select status from import_batches'))[0].status).toBe('cancelled');
});

test('unsuitable files are refused before anything is sent', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('admin_import_begin')) requests.push(r.url()); });
  const wiz = await openWizard(page);

  await upload(page, 'notes.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
  await expect(wiz).toContainText('Please choose a .csv or .xlsx file');
  await upload(page, 'old.xls', Buffer.from('x'), 'application/vnd.ms-excel');
  await expect(wiz).toContainText('Old .xls files are not supported');
  await upload(page, 'fake.xlsx', Buffer.from('this is plain text, not a zip'), 'application/octet-stream');
  await expect(wiz).toContainText('not a valid Excel archive');
  await upload(page, 'empty.csv', Buffer.alloc(0));
  await expect(wiz).toContainText('The file is empty');
  await upload(page, 'rooms.csv', Buffer.from('Room,Capacity\r\nA1,30\r\n'));
  await expect(wiz).toContainText('Missing columns: Employee ID, Name, Department, Examination Date, Session');
  await upload(page, 'headeronly.csv', csv([]));
  await expect(wiz).toContainText('no data rows');
  const big = csv(Array.from({ length: 5001 }, (_, i) => [`E${i}`, 'N', 'D', D1, 'FN']));
  await upload(page, 'toobig.csv', big);
  await expect(wiz).toContainText('limit is 5000 per import');
  expect(requests).toEqual([]);                                            // no import was even started
});

test('a real .xlsx file (Excel date cells, numeric IDs, extra columns) imports correctly', async ({ page }) => {
  const [y, m, d] = D1.split('-').map(Number);
  const buffer = await writeXlsx([
    [...HEADER, 'Mobile'].map((h) => ({ value: h, fontWeight: 'bold' as const })),
    [{ value: 1001, type: Number }, { value: 'Asha Rao', type: String }, { value: 'Physics', type: String }, { value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: 'dd-mm-yyyy' }, { value: 'Forenoon', type: String }, { value: '9999999999', type: String }],
    [{ value: 'E2', type: String }, { value: 'Ben Joy', type: String }, { value: 'Maths', type: String }, { value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: 'yyyy-mm-dd' }, { value: 'AN', type: String }, { value: '8888888888', type: String }],
  ] as never).toBuffer();
  const wiz = await openWizard(page);
  await upload(page, 'roster.xlsx', Buffer.from(buffer), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await expect(wiz).toContainText('roster.xlsx: 2 data rows read');
  await expect(wiz).toContainText('Ignored columns: Mobile');
  await page.getByTestId('start-validation').click();
  await expect(stat(page, 'Valid')).toHaveText('2');
  await page.getByTestId('commit-import').click();
  await page.getByRole('dialog', { name: 'Import these rows?' }).getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByTestId('import-report')).toBeVisible();
  const rows = await sql<{ employee_id: string; exam_date: string; session_label: string }>(`select employee_id, exam_date::text, session_label from schedule order by employee_id`);
  expect(rows).toEqual([{ employee_id: '1001', exam_date: D1, session_label: 'FN' }, { employee_id: 'E2', exam_date: D1, session_label: 'AN' }]);
  expect(JSON.stringify(await sql('select * from schedule'))).not.toMatch(/9999999999|8888888888/);    // the ignored column never reached the server
});

test('network interruption: a lost response and a failed chunk are retried without duplicating rows, and the upload can be resumed', async ({ page }) => {
  const N = 1200;
  const rows = Array.from({ length: N }, (_, i) => [`E${String(i + 1).padStart(5, '0')}`, `Name ${i + 1}`, 'CSE', D1, i % 2 ? 'AN' : 'FN']);
  let lostResponse = 0;
  let failures = 0;
  let chunk2Sent = 0;
  await page.route('**/rest/v1/rpc/admin_import_add_rows', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('"row":2,') && lostResponse < 1) {                // chunk 1: the server RECEIVES it, the answer is lost
      lostResponse++;
      await route.fetch();
      return route.abort('connectionreset');
    }
    if (body.includes('"row":502,')) {                                   // chunk 2 never reaches the server four times in a row
      chunk2Sent++;
      if (failures < 4) { failures++; return route.abort('internetdisconnected'); }
    }
    return route.continue();
  });
  const wiz = await openWizard(page);
  await upload(page, 'big.csv', csv(rows));
  await page.getByTestId('start-validation').click();
  await expect(wiz.getByText('The upload was interrupted')).toBeVisible({ timeout: 40_000 });
  await expect(wiz).toContainText('500 of 1200 rows are already safely on the server');
  const staged = (await sql<{ c: number }>('select count(*)::int c from import_rows'))[0].c;
  expect(staged).toBe(500);                                              // exactly the first chunk, despite it having been sent twice

  await page.getByTestId('start-validation').click();                   // "Retry": continues from row 500 with the same batch
  await expect(page.getByTestId('validation-summary')).toBeVisible({ timeout: 40_000 });
  await expect(stat(page, 'Valid')).toHaveText(String(N));
  expect((await sql<{ c: number }>('select count(*)::int c from import_rows'))[0].c).toBe(N);               // no duplicates
  expect((await sql<{ c: number }>('select count(distinct row_number)::int c from import_rows'))[0].c).toBe(N);
  expect((await sql('select 1 from import_batches')).length).toBe(1);                                      // the same batch was resumed
  expect(chunk2Sent).toBeGreaterThanOrEqual(5);

  await page.getByTestId('commit-import').click();
  await page.getByRole('dialog', { name: 'Import these rows?' }).getByRole('button', { name: `Import ${N} rows` }).click();
  await expect(page.getByTestId('import-report')).toBeVisible();
  expect(await scheduleCount()).toBe(N);
});

test('a 5000-row file is parsed off the main thread, staged in chunks, validated and imported', async ({ page }) => {
  const N = 5000;
  const rows = Array.from({ length: N }, (_, i) => [`EMP${String(i + 1).padStart(5, '0')}`, `Employee ${i + 1}`, `DEPT${i % 25}`, D1, i % 2 ? 'AN' : 'FN']);
  let chunks = 0;
  page.on('request', (r) => { if (r.url().includes('admin_import_add_rows')) chunks++; });
  const wiz = await openWizard(page);
  const t0 = Date.now();
  await upload(page, 'five-thousand.csv', csv(rows));
  await expect(wiz).toContainText('5000 data rows read', { timeout: 30_000 });
  const parsedMs = Date.now() - t0;
  await page.getByTestId('start-validation').click();
  await expect(page.getByTestId('validation-summary')).toBeVisible({ timeout: 60_000 });
  const validatedMs = Date.now() - t0;
  await expect(stat(page, 'Valid')).toHaveText('5000');
  expect(chunks).toBe(10);                                                // 500 rows per request, never one oversized request
  await page.getByTestId('commit-import').click();
  await page.getByRole('dialog', { name: 'Import these rows?' }).getByRole('button', { name: 'Import 5000 rows' }).click();
  await expect(page.getByTestId('import-report')).toBeVisible({ timeout: 60_000 });
  expect(await scheduleCount()).toBe(N);
  console.log(`# 5000-row import in a real browser against the local stack: parsed in ${parsedMs} ms, validated after ${validatedMs} ms (local; not Supabase)`);
});

import { expect, test } from '@playwright/test';
import { ADMIN, createAdmin, loginAs, resetDb, seed, setTokenTtl, sql } from './helpers';

test.beforeEach(async () => { await resetDb(); });

const ROUTES = ['/admin', '/admin/sessions', '/admin/rooms', '/admin/schedule', '/admin/allocations', '/admin/verification', '/admin/audit', '/admin/reports', '/admin/settings'];

test('every admin route sends a signed-out visitor to the login page and shows nothing protected', async ({ page }) => {
  await seed({ employees: 2 });
  for (const r of ROUTES) {
    await page.goto(r);
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole('heading', { name: 'Administrator sign in' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('E0001');
  }
});

test('login errors, successful sign-in, session survives a reload, sign-out', async ({ page }) => {
  await createAdmin();
  await loginAs(page, ADMIN.email, 'wrong password');
  await expect(page.getByText('Incorrect email or password.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login$/);

  await loginAs(page);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('admin-identity')).toContainText(ADMIN.email);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();   // stored session is re-validated against the database

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto('/admin/audit');
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('a signed-in user who is NOT an active administrator sees an unauthorized screen and no data', async ({ page }) => {
  await seed({ employees: 3 });
  await createAdmin({ email: 'stranger@example.test', admin: false });
  await loginAs(page, 'stranger@example.test');
  await expect(page.getByRole('heading', { name: 'No administrator access' })).toBeVisible();
  await expect(page.getByText('stranger@example.test')).toBeVisible();
  for (const r of ['/admin/schedule', '/admin/audit', '/admin/allocations']) {
    await page.goto(r);
    await expect(page.getByRole('heading', { name: 'No administrator access' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('E0001');
  }
});

test('an admin who is deactivated while signed in loses access on the very next request', async ({ page }) => {
  await seed({ employees: 2 });
  await createAdmin();
  await loginAs(page);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('stat-cards')).toBeVisible();                       // the first load has finished: what follows is the BACKGROUND refresh
  await sql(`update admins set is_active = false where email = $1`, [ADMIN.email]);
  // the dashboard refreshes every 8 s; the first refresh after deactivation is refused by the database (403)
  // and the portal switches to the unauthorized screen without any user action
  await expect(page.getByRole('heading', { name: 'No administrator access' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
  await page.goto('/admin/audit');                                   // and a fresh navigation is refused too
  await expect(page.getByRole('heading', { name: 'No administrator access' })).toBeVisible();
});

test('a session that arrives already expired (e.g. wrong device clock) is explained, not silent', async ({ page }) => {
  await createAdmin();
  await setTokenTtl(-300);                              // the stand-in auth issues a token that is already expired
  await loginAs(page);
  await expect(page.getByText('Your session has expired. Please sign in again.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await setTokenTtl(3600);
  await loginAs(page);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('when the server rejects the access token mid-session (expiry), the user is signed out with an explanation', async ({ page }) => {
  await seed({ employees: 2 });
  await createAdmin();
  await loginAs(page);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('stat-cards')).toBeVisible();
  // SIMULATED server answer: this is what PostgREST returns for an expired JWT (see tests/api/api.test.js for the real one)
  await page.route('**/rest/v1/rpc/admin_overview', (route) => route.fulfill({ status: 401, contentType: 'application/json',
    body: JSON.stringify({ code: 'PGRST303', message: 'JWT expired' }) }));
  // no navigation: the open dashboard's own 8 s background refresh meets the 401
  await expect(page.getByText('Your session has expired. Please sign in again.')).toBeVisible({ timeout: 25_000 });
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('a user who bypasses the client-side guard still gets nothing from the database', async ({ page, request }) => {
  await seed({ employees: 2 });
  await createAdmin({ email: 'stranger@example.test', admin: false });
  const login = await request.post('http://127.0.0.1:54321/auth/v1/token?grant_type=password', { data: { email: 'stranger@example.test', password: ADMIN.password } });
  expect(login.status()).toBe(200);
  const token = (await login.json()).access_token as string;
  const r = await request.post('http://127.0.0.1:54321/rest/v1/rpc/admin_list_schedule', {
    headers: { authorization: `Bearer ${token}`, apikey: token }, data: {} });
  expect(r.status()).toBe(403);
  expect(JSON.stringify(await r.json())).toContain('not authorized');
  expect(page).toBeTruthy();
});

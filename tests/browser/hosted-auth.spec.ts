import { test, expect, type Page } from '@playwright/test';
import type { Dashboard } from '../../shared/types';

const account = { id: 'hosted-user', name: 'Hosted Player', email: 'hosted@example.test' };
const password = 'A-new-survivor-password-2026!';

async function hostedRoutes(page: Page, signedIn = false) {
  await page.route('**/api/health', route => route.fulfill({ json: { status: 'ok', authProvider: 'supabase', passwordRecovery: true } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { user: signedIn ? account : null } }));
  await page.route('**/api/leagues', route => route.fulfill({ json: { leagues: [] } }));
}

async function openSignIn(page: Page) {
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  return page.getByRole('dialog');
}

test('hosted registration waits for email confirmation without presenting an authenticated account', async ({ page }) => {
  await hostedRoutes(page);
  let submittedEmail = '';
  await page.route('**/api/auth/register', async route => {
    submittedEmail = route.request().postDataJSON().email;
    await route.fulfill({ json: { user: null, confirmationRequired: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Start your league', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Display name').fill('Hosted Player');
  await dialog.getByLabel('Email address').fill(account.email);
  await dialog.locator('input[autocomplete="new-password"]').fill(password);
  await dialog.getByRole('button', { name: 'Create your account', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'CHECK YOUR INBOX.' })).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText(account.email);
  await expect(page.locator('.user-menu')).toContainText('Guest player');
  expect(submittedEmail).toBe(account.email);
  await dialog.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(dialog.getByRole('heading', { name: 'WELCOME BACK.' })).toBeVisible();
  await expect(dialog.locator('input[autocomplete="current-password"]')).toHaveValue('');
});

test('password reset requests show a generic confirmation without revealing account existence', async ({ page }) => {
  await hostedRoutes(page);
  let email = '';
  await page.route('**/api/auth/forgot-password', async route => {
    email = route.request().postDataJSON().email;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  const dialog = await openSignIn(page);
  await dialog.getByRole('button', { name: 'Forgot password?' }).click();
  await dialog.getByLabel('Email address').fill('unknown@example.test');
  await dialog.getByRole('button', { name: 'Send reset link' }).click();
  await expect(dialog.getByRole('status')).toContainText('If an account exists');
  expect(email).toBe('unknown@example.test');
});

test('recovery callback survives StrictMode, validates matching passwords, and sends the update', async ({ page }) => {
  await hostedRoutes(page, true);
  let submittedPassword: string | undefined;
  await page.route('**/api/auth/reset-password', async route => {
    submittedPassword = route.request().postDataJSON().password;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/?auth=recovery');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('New password', { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/auth=recovery/);
  await dialog.getByLabel('New password', { exact: true }).fill(password);
  await dialog.getByLabel('Confirm new password', { exact: true }).fill('Different-password-2026!');
  await dialog.getByRole('button', { name: 'Save new password' }).click();
  await expect(dialog.getByRole('alert')).toContainText('do not match');
  expect(submittedPassword).toBeUndefined();
  await dialog.getByLabel('Confirm new password', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Save new password' }).click();
  await expect(dialog).toBeHidden();
  expect(submittedPassword).toBe(password);
  await expect(page.getByRole('status')).toContainText('Your password has been updated.');
});

test('an expired recovery session offers a fresh link instead of a password update form', async ({ page }) => {
  await hostedRoutes(page);
  await page.goto('/?auth=recovery');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('This link is no longer available');
  await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Request a new link' }).click();
  await expect(dialog.getByLabel('Email address')).toBeVisible();
});

test('an unconfigured hosted service keeps the demo usable and explains account readiness', async ({ page }) => {
  await page.route('**/api/health', route => route.fulfill({ status: 503, json: { status: 'unconfigured', error: 'Hosted configuration is incomplete.' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, json: { error: 'Hosted configuration is incomplete.' } }));
  await page.route('**/api/auth/login', route => route.fulfill({ status: 503, json: { error: 'Hosted configuration is incomplete. Finish environment setup and redeploy.' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'EVERY PICK COUNTS.' })).toBeVisible();
  await expect(page.locator('.data-warning')).toContainText('site owner finishes the hosting setup');
  const dialog = await openSignIn(page);
  await dialog.getByLabel('Email address').fill(account.email);
  await dialog.locator('input[autocomplete="current-password"]').fill(password);
  await dialog.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Finish environment setup and redeploy');
});

async function privateFixture(page: Page, id: string, name: string): Promise<Dashboard> {
  const response = await page.request.get('/api/demo');
  const demo = await response.json() as Dashboard;
  return {
    ...demo,
    demo: false,
    currentUserId: account.id,
    league: { ...demo.league, id, name },
    members: demo.members.map((member, index) => index ? member : { ...member, id: account.id, name: account.name }),
  };
}

test('a late private dashboard response cannot restore account data after logout', async ({ page }) => {
  await hostedRoutes(page, true);
  const data = await privateFixture(page, 'private-one', 'PRIVATE LEAGUE MUST STAY CLEARED');
  await page.route('**/api/leagues', route => route.fulfill({ json: { leagues: [data.league] } }));
  let release: () => void = () => {};
  const released = new Promise<void>(resolve => { release = resolve; });
  let received: () => void = () => {};
  const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/leagues/private-one', async route => {
    received();
    await released;
    await route.fulfill({ json: data });
  });
  await page.route('**/api/auth/logout', route => route.fulfill({ json: { ok: true } }));
  await page.goto('/');
  await requested;
  await expect(page.locator('.user-menu')).toContainText(account.name);
  await page.locator('.user-menu').click();
  await expect(page.locator('.user-menu')).toContainText('Guest player');
  release();
  await expect(page.locator('.preview-banner')).toBeVisible();
  await expect(page.getByText(data.league.name, { exact: true })).toHaveCount(0);
  await page.waitForTimeout(150);
  await expect(page.locator('.user-menu')).toContainText('Guest player');
  await expect(page.getByText(data.league.name, { exact: true })).toHaveCount(0);
});

test('a delayed league selection cannot overwrite a newer selection', async ({ page }) => {
  await hostedRoutes(page, true);
  const first = await privateFixture(page, 'first', 'First League');
  const second = { ...first, league: { ...first.league, id: 'second', name: 'Second League' } };
  await page.route('**/api/leagues', route => route.fulfill({ json: { leagues: [first.league, second.league] } }));
  await page.route('**/api/leagues/first', route => route.fulfill({ json: first }));
  let release: () => void = () => {};
  const released = new Promise<void>(resolve => { release = resolve; });
  let received: () => void = () => {};
  const requested = new Promise<void>(resolve => { received = resolve; });
  await page.route('**/api/leagues/second', async route => { received(); await released; await route.fulfill({ json: second }); });
  await page.goto('/');
  await expect(page.locator('.league-switcher')).toContainText('First League');
  await page.getByRole('button', { name: 'Manage leagues' }).click();
  await page.locator('.league-popover').getByRole('button', { name: 'Second League' }).click();
  await requested;
  await page.getByRole('button', { name: 'Manage leagues' }).click();
  await page.locator('.league-popover').getByRole('button', { name: 'First League' }).click();
  release();
  await expect(page.locator('.league-switcher')).toContainText('First League');
  await page.waitForTimeout(150);
  await expect(page.locator('.league-switcher')).toContainText('First League');
});

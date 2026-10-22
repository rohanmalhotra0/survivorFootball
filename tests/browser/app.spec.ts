import { test, expect, type Page } from '@playwright/test';

async function register(page: Page, displayName: string, email: string) {
  await page.getByRole('button', { name: 'Start your league', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Display name').fill(displayName);
  await dialog.getByLabel('Email address').fill(email);
  await dialog.locator('input[autocomplete="new-password"]').fill('Browser-test-password-2026!');
  await dialog.getByRole('button', { name: 'Create your account', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Your people. Your league.', { exact: true })).toBeVisible();
}

test('desktop dashboard, demo picker, standings, rules and roster search work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'EVERY PICK COUNTS.' })).toBeVisible();
  await expect(page.locator('.preview-banner')).toBeVisible();
  await expect(page.locator('.matchup-card').first()).toBeVisible();
  await page.screenshot({ path: 'artifacts/dashboard-desktop.png', fullPage: true });
  await page.getByRole('button', { name: /Make your pick|Review your pick/ }).first().click();
  const pickDialog = page.getByRole('dialog');
  await expect(pickDialog.getByRole('heading', { name: 'MAKE YOUR MOVE.' })).toBeVisible();
  await pickDialog.locator('.team-option:not(:disabled)').first().click();
  await pickDialog.getByRole('button', { name: 'Save preview pick' }).click();
  await expect(pickDialog).toBeHidden();
  await expect(page.locator('.hero-selection')).toBeVisible();
  await page.getByRole('button', { name: 'Standings', exact: true }).click();
  await expect(page.locator('.standings-panel')).toBeVisible();
  await page.getByRole('button', { name: 'League rules', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('America/New_York');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search players' }).fill('Mahomes');
  await expect(page.locator('.player-card')).toHaveCount(1);
  await expect(page.locator('.player-card')).toContainText('Patrick Mahomes');
  await page.getByRole('textbox', { name: 'Search players' }).fill('NoSuchNFLPlayerXYZ');
  await expect(page.getByText('No players found.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile dashboard fits its viewport and navigation opens and closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'EVERY PICK COUNTS.' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/dashboard-mobile.png', fullPage: true });
  const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Search players' })).toBeVisible();
  await expect(page.locator('.nav-overlay')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search players' }).fill('Mahomes');
  await expect(page.locator('.player-card')).toHaveCount(1);
});

test('real registration, league creation, pick persistence, sign-out and sign-in work', async ({ page }) => {
  const email = `browser-${Date.now()}@example.test`;
  const name = `QA ${Date.now()}`;
  const leagueName = `Sunday QA ${Date.now()}`;
  await page.goto('/');
  await register(page, name, email);
  await page.getByRole('button', { name: 'Create a league', exact: true }).first().click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('League name').fill(leagueName);
  await dialog.getByRole('button', { name: 'Create league', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.league-switcher')).toContainText(leagueName);
  await expect(page.locator('.preview-banner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Make your pick', exact: true }).click();
  dialog = page.getByRole('dialog');
  const firstEligible = dialog.locator('.team-option:not(:disabled)').first();
  await expect(firstEligible).toBeVisible();
  await firstEligible.click();
  await dialog.getByRole('button', { name: 'Lock in your pick', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.hero-selection')).toBeVisible();
  const selection = await page.locator('.hero-selection strong').innerText();
  await page.reload();
  await expect(page.locator('.hero-selection strong')).toHaveText(selection);
  const initialWeek = Number((await page.locator('.week-selector').innerText()).match(/Week (\d+)/)?.[1]);
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.locator('.week-selector')).toContainText(`Week ${initialWeek + 1}`);
  await page.getByRole('button', { name: 'Previous week' }).click();
  await expect(page.locator('.hero-selection strong')).toHaveText(selection);
  await page.getByRole('button', { name: 'Create a league', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('League name').fill(`${leagueName} Second`);
  await page.getByRole('dialog').getByRole('button', { name: 'Create league', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.league-switcher')).toContainText(`${leagueName} Second`);
  await expect(page.locator('.hero-selection')).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage leagues' }).click();
  await page.locator('.league-popover').getByRole('button', { name: leagueName, exact: true }).click();
  await expect(page.locator('.hero-selection strong')).toHaveText(selection);
  await page.locator('.user-menu').click();
  await expect(page.locator('.preview-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(email);
  await dialog.locator('input[autocomplete="current-password"]').fill('wrong-password-2026!');
  await dialog.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('incorrect');
  await dialog.locator('input[autocomplete="current-password"]').fill('Browser-test-password-2026!');
  await dialog.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Manage leagues' }).click();
  await page.locator('.league-popover').getByRole('button', { name: leagueName, exact: true }).click();
  await expect(page.locator('.hero-selection strong')).toHaveText(selection);
});

test('a second user can join with an invite and sees the first user pick sealed', async ({ page, browser }) => {
  await page.goto('/');
  await register(page, `Owner ${Date.now()}`, `owner-${Date.now()}@example.test`);
  await page.getByRole('button', { name: 'Create a league', exact: true }).first().click();
  await page.getByRole('dialog').getByLabel('League name').fill('Private browser league');
  await page.getByRole('dialog').getByRole('button', { name: 'Create league', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const leaguesResponse = await page.request.get('/api/leagues');
  const { leagues } = await leaguesResponse.json();
  expect(leagues.length).toBe(1);
  await page.getByRole('button', { name: 'Make your pick', exact: true }).click();
  await page.getByRole('dialog').locator('.team-option:not(:disabled)').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Lock in your pick' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const context = await browser.newContext();
  try {
    const teammate = await context.newPage();
    await teammate.goto(new URL('/', page.url()).href);
    await register(teammate, `Teammate ${Date.now()}`, `member-${Date.now()}@example.test`);
    await teammate.getByRole('button', { name: 'Join with a code', exact: true }).click();
    await teammate.getByRole('dialog').getByLabel('Invite code').fill(leagues[0].inviteCode);
    await teammate.getByRole('dialog').getByRole('button', { name: 'Join league', exact: true }).click();
    await expect(teammate.getByRole('dialog')).toBeHidden();
    await expect(teammate.locator('.league-switcher')).toContainText('Private browser league');
    await teammate.getByRole('button', { name: 'Standings', exact: true }).click();
    await expect(teammate.locator('.members-table tbody tr')).toHaveCount(2);
    const result = await teammate.request.get(new URL(`/api/leagues/${leagues[0].id}`, page.url()).href);
    const body = await result.json();
    expect(body.members.find((member: { name: string }) => member.name.startsWith('Owner')).pick).toBeNull();
  } finally { await context.close(); }
});

test('dialogs keep keyboard focus inside and restore it to the opener on Escape', async ({ page }) => {
  await page.goto('/');
  const opener = page.locator('.topbar').getByRole('button', { name: 'Sign in', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Email address')).toBeFocused();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await dialog.getByRole('button', { name: 'Close dialog' }).focus();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('the reveal countdown refetches at its boundary and never unmasks picks without the server', async ({ page }) => {
  const response = await page.request.get('/api/demo');
  const fixture = await response.json();
  fixture.revealAt = '2026-10-25T17:00:00.000Z';
  fixture.picksRevealed = false;
  fixture.members = fixture.members.map((member: { id: string; history: unknown[] }) => ({ ...member, pick: null, pickState: 'hidden', history: [] }));
  let requests = 0;
  await page.clock.install({ time: new Date('2026-10-25T16:59:59.000Z') });
  await page.route('**/api/demo*', async route => {
    requests++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Standings', exact: true }).click();
  await expect(page.locator('.standings-notice')).toContainText('Picks are private');
  await page.clock.runFor(100);
  const initialRequests = requests;
  expect(initialRequests).toBeGreaterThan(0);
  await page.clock.runFor(1500);
  await expect.poll(() => requests).toBeGreaterThan(initialRequests);
  await expect(page.locator('.standings-notice')).toContainText('Picks are private');
  await expect(page.locator('.revealed-pick')).toHaveCount(0);
});

test('small-phone and tablet layouts have no horizontal overflow or overlapping strategy text', async ({ page }) => {
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('.strategy-card')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(() => {
      const heading = document.querySelector('.strategy-card h2')!.getBoundingClientRect();
      const paragraph = document.querySelector('.strategy-card p')!.getBoundingClientRect();
      return { width: innerWidth, document: document.documentElement.scrollWidth,
        overlaps: heading.left < paragraph.right && heading.right > paragraph.left && heading.top < paragraph.bottom && heading.bottom > paragraph.top };
    });
    expect(geometry.document, `Horizontal overflow at ${width}px`).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.overlaps, `Strategy copy overlap at ${width}px`).toBe(false);
    if (width === 768) await page.screenshot({ path: 'artifacts/dashboard-tablet.png', fullPage: true });
  }
});

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const title = 'Senior Scrum Master & Agile Coach';
const dates = '06/2020 – 08/2023';
const planning = 'Slashed planning time by 50% for quarterly planning for 50+ engineers';
const row = (page: Page, id: string) => page.locator(`[data-truth-id="${id}"]`);
async function arity(page: Page) {
  await page.getByRole('button', { name: 'Work experience', exact: true }).click();
  await page.getByText('Choose role or filter', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Role', exact: true }).selectOption('experience.3');
  await page.getByText('Choose role or filter', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Arity — Chicago, IL', exact: true })).toBeVisible();
}
async function noOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map((element) => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width })) }));
  expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
}
test.beforeEach(async ({ page, request }) => {
  await request.post('/__test/reset'); await page.goto('/jobs/truths');
  await expect(page.getByRole('heading', { name: 'Personal details', exact: true })).toBeVisible();
});

test('batch selection, undo, version history and database restart persistence', async ({ page, request }) => {
  await arity(page);
  await expect(page.getByRole('button', { name: 'Approve 0 selected' })).toBeDisabled();
  await page.getByRole('checkbox', { name: title, exact: true }).check();
  await page.getByRole('checkbox', { name: dates, exact: true }).check();
  await page.getByRole('button', { name: 'Approve 2 selected' }).click();
  await expect(page.getByRole('status')).toContainText('2 truths approved');
  await expect(row(page, 'experience.3.title').getByText('Reviewed', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: planning, exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Undo last approval' }).click();
  await expect(page.getByRole('status')).toContainText('Approval undone');
  await expect(page.getByRole('checkbox', { name: title, exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'View source notes', exact: true }).click();
  await row(page, 'experience.3.title').getByText('Source and history', { exact: true }).click();
  await row(page, 'experience.3.title').getByRole('button', { name: 'View version history' }).click();
  await expect(row(page, 'experience.3.title').locator('.jobsHistory > li')).toHaveCount(3);
  await page.getByRole('checkbox', { name: title, exact: true }).check();
  await page.getByRole('button', { name: 'Approve 1 selected' }).click();
  await expect(page.getByRole('status')).toContainText('1 truth approved');
  await request.post('/__test/restart'); await page.reload(); await arity(page);
  await expect(row(page, 'experience.3.title').getByText('Reviewed', { exact: true })).toBeVisible();
});

test('related copies require independent selection and filters limit select-all', async ({ page }) => {
  await arity(page);
  await page.getByRole('checkbox', { name: 'Select all 5 visible unreviewed facts' }).check();
  await expect(page.getByRole('button', { name: 'Approve 5 selected' })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Select all 5 visible unreviewed facts' }).uncheck();
  await page.getByRole('button', { name: /Compare related wording/ }).click();
  await expect(page.getByText('Role source:', { exact: false })).toBeVisible();
  await row(page, 'accomplishment.6').getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve 1 selected' }).click();
  await expect(page.getByRole('status')).toContainText('1 truth approved');
  await expect(page.getByRole('checkbox', { name: planning, exact: true })).not.toBeChecked();
  await page.getByText('Choose role or filter', { exact: true }).click();
  await page.getByLabel('Search this group').fill('06/2020');
  await page.getByRole('checkbox', { name: 'Select all 1 visible unreviewed facts' }).check();
  await expect(page.getByRole('button', { name: 'Approve 1 selected' })).toBeEnabled();
});

test('inline editing, rejection, renewed approval and unsaved navigation guard', async ({ page }) => {
  await arity(page);
  await row(page, 'experience.3.title').getByRole('button', { name: /^Edit:/ }).click();
  await expect(page.getByRole('textbox', { name: 'Claim', exact: true })).toBeFocused();
  await page.getByRole('textbox', { name: 'Claim', exact: true }).fill('Corrected role title');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Save or cancel');
  await expect(page.getByRole('textbox', { name: 'Claim', exact: true })).toHaveValue('Corrected role title');
  await page.getByRole('button', { name: 'Save & approve' }).click();
  await expect(page.getByRole('status')).toContainText('1 truth approved');
  await row(page, 'experience.3.title').getByRole('button', { name: /^Edit:/ }).click();
  await page.getByRole('textbox', { name: 'Claim', exact: true }).fill('Revised title needing review');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(row(page, 'experience.3.title').getByRole('checkbox')).toBeVisible();
  await row(page, 'experience.3.dates').getByRole('button', { name: /^Edit:/ }).click();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(row(page, 'experience.3.dates').getByText('Rejected', { exact: true })).toBeVisible();
});

test('stale batches save nothing and preserve selection; refresh exposes current facts', async ({ page, request }) => {
  await arity(page);
  await page.getByRole('checkbox', { name: title, exact: true }).check();
  await page.getByRole('checkbox', { name: dates, exact: true }).check();
  const { claims } = await (await request.get('/api/jobs/resume-truth')).json();
  const current = claims.find((claim: { id: string }) => claim.id === 'experience.3.title');
  await request.post('/api/jobs/resume-truth', { data: { changes: [{ id: current.id, expectedVersion: current.version, reviewStatus: 'unreviewed', claim: 'Changed elsewhere' }] } });
  await page.getByRole('button', { name: 'Approve 2 selected' }).click();
  await expect(page.getByRole('alert')).toContainText('Nothing was saved');
  await expect(page.getByRole('checkbox', { name: dates, exact: true })).toBeChecked();
  const after = await (await request.get('/api/jobs/resume-truth')).json();
  expect(after.claims.find((claim: { id: string }) => claim.id === 'experience.3.dates').reviewStatus).toBe('unreviewed');
  await page.getByRole('button', { name: 'Refresh saved truths' }).click();
  await expect(page.getByRole('checkbox', { name: 'Changed elsewhere', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Approve 2 selected' }).click();
  await expect(page.getByRole('status')).toContainText('2 truths approved');
});

test('failed saves retain the inline draft and offer retry', async ({ page }) => {
  await arity(page); await row(page, 'experience.3.title').getByRole('button', { name: /^Edit:/ }).click();
  await page.getByRole('textbox', { name: 'Claim', exact: true }).fill('Retained draft');
  await page.route('**/api/jobs/resume-truth', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary save failure' }) }); else await route.continue();
  });
  await page.getByRole('button', { name: 'Save & approve' }).click();
  await expect(page.getByRole('alert')).toContainText('Temporary save failure');
  await expect(page.getByRole('textbox', { name: 'Claim', exact: true })).toHaveValue('Retained draft');
  await page.unroute('**/api/jobs/resume-truth');
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByRole('status')).toContainText('1 truth approved');
});

test('keyboard access, contrast, target sizes, native screenshot and 200% reflow', async ({ page }, testInfo) => {
  await arity(page); await noOverflow(page);
  await page.getByRole('checkbox', { name: title, exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('checkbox', { name: title, exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: title, exact: true })).toHaveCSS('outline-style', 'solid');
  await page.getByRole('checkbox', { name: dates, exact: true }).check();
  await page.getByRole('checkbox', { name: planning, exact: true }).check();
  await page.screenshot({ path: testInfo.outputPath('grouped-review.png'), fullPage: true });
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations).toEqual([]);
  const small = await page.locator('.truthReview button:visible, .truthReview summary:visible, .truthChoice:visible').evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().height < 55.9).map((element) => element.textContent));
  expect(small).toEqual([]);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await noOverflow(page); await page.screenshot({ path: testInfo.outputPath('grouped-review-200-percent.png'), fullPage: true });
  await page.getByRole('button', { name: 'Approve 3 selected' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('3 truths approved');
  await page.getByRole('button', { name: 'Undo last approval' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Approval undone');
  await page.getByRole('button', { name: 'Next role' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'WorkTango — Chicago, IL', exact: true })).toBeFocused();
});


test('tab order reaches selection, editing, comparison and approval without pointer input', async ({ page }) => {
  await arity(page);
  const reach = async (target: ReturnType<Page['getByRole']>) => {
    for (let index = 0; index < 60; index++) {
      await page.keyboard.press('Tab');
      if (await target.evaluate((element) => element === document.activeElement)) return;
    }
    throw new Error('Control not reachable in the tab order');
  };
  await reach(page.getByRole('checkbox', { name: title, exact: true }));
  await page.keyboard.press('Space');
  await reach(row(page, 'experience.3.title').getByRole('button', { name: /^Edit:/ }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Claim', exact: true })).toBeFocused();
  await reach(page.getByRole('button', { name: 'Cancel', exact: true }));
  await page.keyboard.press('Enter');
  await reach(page.getByRole('button', { name: /Compare related wording/ }));
  await page.keyboard.press('Enter');
  await expect(row(page, 'accomplishment.6').getByRole('checkbox')).toBeVisible();
  await reach(row(page, 'accomplishment.6').getByRole('checkbox'));
  await page.keyboard.press('Space');
  await reach(page.getByRole('button', { name: 'Approve 2 selected' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('2 truths approved');
});

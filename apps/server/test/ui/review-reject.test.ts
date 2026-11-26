// A stack's drafts go ready for review at once, and rejecting a layer says what you want
// for it: changed, out of the stack (its PR stays open), or closed on GitHub. Real page →
// disposable host → a stand-in GitHub (test/ui/reviewHost.ts). No production state.
import '../scratch.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { devices } from 'playwright-core';
import { http, until } from '../helpers.ts';
import { chrome, reviewHost, shotsDir, type ReviewHost } from './reviewHost.ts';

const skip = chrome ? false : 'no Chromium';
const shots = shotsDir('AH_REVIEW_REJECT_SHOTS');
let host: ReviewHost;

before(async () => {
  if (skip) return;
  // #2 and #3 start as drafts, the way gh stack submit --auto opens them.
  host = await reviewHost((p) => ({ ...p, isDraft: p.number !== 1 }));
});

after(async () => {
  if (host) await host.stop();
});

const state = (n: number) => host.prs().find((p) => p.number === n)!;

test('desktop: every draft goes ready for review in one go', { skip, timeout: 120_000 }, async () => {
  const { ctx, page, errors } = await host.open({ viewport: { width: 1280, height: 860 } }, `review/${host.stackId}`);
  const ready = page.getByRole('button', { name: 'Ready for review (2)' });
  await ready.waitFor({ timeout: 20_000 });
  if (shots) await page.screenshot({ path: join(shots, 'desktop-drafts.png') });
  await ready.click();
  const confirm = page.getByRole('dialog').filter({ hasText: 'Mark all 2 drafts ready for review?' });
  await confirm.waitFor();
  if (shots) await confirm.screenshot({ path: join(shots, 'desktop-ready-confirm.png') });
  await confirm.getByRole('button', { name: 'Ready all 2' }).click();
  await until(async () => !state(2).isDraft && !state(3).isDraft, 20_000, 'both out of draft');
  assert.match(host.ghLog(), /pr ready 2\n[\s\S]*pr ready 3\n/, 'bottom up');
  await ready.waitFor({ state: 'detached', timeout: 20_000 });
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('desktop: rejecting asks what you want for it; out of the stack leaves its PR open', { skip, timeout: 120_000 }, async () => {
  const { ctx, page, errors } = await host.open({ viewport: { width: 1280, height: 860 } }, `review/${host.stackId}/3`);
  await page.getByRole('heading', { name: /Document c/ }).first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /^(Layer|More)$/ }).first().click();
  await page.getByRole('button', { name: 'Reject #3…' }).click();
  const dialog = page.locator('dialog.review-reject');
  await dialog.waitFor();
  const choices = dialog.getByRole('radiogroup', { name: 'What happens to it' });
  assert.equal(await choices.getByRole('radio', { name: /Request changes/ }).isChecked(), true, 'changed, until you say otherwise');
  if (shots) await dialog.screenshot({ path: join(shots, 'desktop-reject.png') });

  // Request changes goes on to the message, with the layer it's about.
  await dialog.getByRole('button', { name: 'Write the request…' }).click();
  await page.locator('dialog.review-dispatch').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('dialog.review-dispatch').waitFor({ state: 'detached' });

  await page.getByRole('button', { name: /^(Layer|More)$/ }).first().click();
  await page.getByRole('button', { name: 'Reject #3…' }).click();
  await dialog.getByText('Take it out of the stack').click();
  await dialog.getByRole('button', { name: 'Take it out' }).click();
  await until(async () => !(await http(host.ah, 'GET', `/api/review/stacks/${host.stackId}`)).json().layers.some((l: { pr: number }) => l.pr === 3), 20_000, '#3 out of the stack');
  assert.equal(state(3).state, 'OPEN', 'its PR stays open on GitHub');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: close on GitHub is the third way out, with a comment', { skip, timeout: 120_000 }, async () => {
  const { ctx, page, errors } = await host.open(devices['iPhone 15 Pro'], `review/${host.stackId}/2`, 'dark');
  await page.getByText('Add c').first().waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /^(Layer|More)$/ }).first().tap();
  await page.getByRole('button', { name: 'Reject #2…' }).tap();
  const dialog = page.locator('dialog.review-reject');
  await dialog.getByText('Close #2 on GitHub').tap();
  await dialog.locator('textarea').fill('Superseded by #1.');
  if (shots) await page.waitForTimeout(400).then(() => page.screenshot({ path: join(shots, 'phone-reject-close.png') }));
  await dialog.getByRole('button', { name: 'Close #2' }).tap();
  await until(async () => state(2).state === 'CLOSED', 20_000, '#2 closed');
  assert.match(host.ghLog(), /pr close 2 --comment Superseded by #1\./);
  assert.deepEqual(errors, []);
  await ctx.close();
});

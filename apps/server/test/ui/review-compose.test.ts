// The message to the agent is a composer: files go with it, dictation where the browser has
// it, and what you send can go on the PR as a review. Real page → disposable host → a
// stand-in GitHub and a stand-in agent that keeps what it's typed (test/ui/reviewHost.ts).
import '../scratch.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { devices } from 'playwright-core';
import { http, until } from '../helpers.ts';
import { chrome, reviewHost, shotsDir, type ReviewHost } from './reviewHost.ts';

const skip = chrome ? false : 'no Chromium';
const shots = shotsDir('AH_REVIEW_COMPOSE_SHOTS');
let host: ReviewHost;

before(async () => {
  if (skip) return;
  host = await reviewHost(undefined, { agent: true });
  const f = await http(host.ah, 'POST', `/api/review/stacks/${host.stackId}/findings`, { body: { ownerPr: 2, title: 'Return 2', body: 'c should return 2.', severity: 'blocking', path: 'c.ts', lineStart: 1 } });
  assert.equal(f.status, 200, f.body);
});

after(async () => {
  if (host) await host.stop();
});

test('desktop: a finding goes with a file to the agent, and on the PR as a review', { skip, timeout: 120_000 }, async () => {
  const { ctx, page, errors } = await host.open({ viewport: { width: 1280, height: 900 } }, `review/${host.stackId}/2`);
  await page.getByRole('button', { name: /^Send 1 to / }).click();
  const dialog = page.locator('dialog.review-dispatch');
  await dialog.getByRole('combobox', { name: 'Session to send to' }).waitFor({ timeout: 20_000 });
  await until(async () => /Fixer/.test((await dialog.getByRole('combobox', { name: 'Session to send to' }).textContent()) ?? ''), 20_000, 'the agent offered');
  const session = dialog.getByRole('combobox', { name: 'Session to send to' });
  await session.selectOption((await session.locator('option', { hasText: 'Fixer' }).first().getAttribute('value'))!);
  const post = dialog.getByRole('checkbox', { name: 'Also post on GitHub' });
  assert.equal(await post.isChecked(), true, 'on, until you turn it off');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'repro.log', mimeType: 'text/plain', buffer: Buffer.from('c() returned 1\n') });
  await dialog.locator('.composer-file:not(.uploading)').waitFor({ timeout: 20_000 });
  const message = dialog.getByRole('textbox', { name: 'Message' });
  await message.press('End');
  await message.pressSequentially('\nThe log shows it.');
  if (shots) await dialog.screenshot({ path: join(shots, 'desktop-compose.png') });
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 20_000 });

  await until(async () => /Attached: '/.test(host.agentInput()), 20_000, 'the agent got it');
  const heard = host.agentInput();
  assert.match(heard, /Review of #2 "Add c" \(branch feat\) at [0-9a-f]{8}/, 'which layer and commit');
  assert.match(heard, /Attached: '\/[^']+repro\.log'/, 'the file, by its path on the host');
  const [review] = host.reviews();
  assert.equal(review.n, 2);
  assert.deepEqual(review.comments.map((c) => [c.path, c.line]), [['c.ts', 1]], 'the finding on its line');
  assert.doesNotMatch(JSON.stringify(review), /repro\.log|uploads/, "the host's files stay off GitHub");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone: turned off, it stays off, and nothing more goes on GitHub', { skip, timeout: 120_000 }, async () => {
  const { ctx, page, errors } = await host.open(devices['iPhone 15 Pro'], `review/${host.stackId}/2`, 'dark');
  // The layer's bar, once the layer is in: its menu has the send.
  await page.getByRole('button', { name: 'Next layer, #3' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /^(Layer|More)$/ }).first().tap();
  await page.getByRole('button', { name: /^Send feedback to / }).tap();
  const dialog = page.locator('dialog.review-dispatch');
  const message = dialog.getByRole('textbox', { name: 'Message' });
  await message.waitFor({ timeout: 20_000 });
  await dialog.getByRole('checkbox', { name: 'Also post on GitHub' }).uncheck();
  await message.fill('Rename the helper.');
  if (shots) await page.waitForTimeout(400).then(() => page.screenshot({ path: join(shots, 'phone-compose.png') }));
  await dialog.getByRole('button', { name: 'Send', exact: true }).tap();
  await dialog.waitFor({ state: 'detached', timeout: 20_000 });
  await until(async () => /Rename the helper\./.test(host.agentInput()), 20_000, 'the agent got it');
  assert.equal(host.reviews().length, 1, 'nothing more on GitHub');

  await page.getByRole('button', { name: /^(Layer|More)$/ }).first().tap();
  await page.getByRole('button', { name: /^Send feedback to / }).tap();
  await dialog.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: 20_000 });
  assert.equal(await dialog.getByRole('checkbox', { name: 'Also post on GitHub' }).isChecked(), false, 'remembered');
  assert.deepEqual(errors, []);
  await ctx.close();
});

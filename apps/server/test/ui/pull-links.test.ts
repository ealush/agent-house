// A link to a pull request opens its review here, as a chip in what the agent said and in the
// box: real page → disposable host → a stand-in GitHub (me/proj, #1 ← #2 ← #3 in review) and a
// stand-in agent whose answer links #2 (test/ui/reviewHost.ts).
import '../scratch.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { devices } from 'playwright-core';
import { until } from '../helpers.ts';
import { chrome, reviewHost, shotsDir, type ReviewHost } from './reviewHost.ts';

const skip = chrome ? false : 'no Chromium';
const shots = shotsDir('AH_PULL_LINK_SHOTS');
let host: ReviewHost;

const SAYS = 'The confirmation fix is up as PR #2 (https://github.com/me/proj/pull/2). On the simulator, your message now turns into the host’s copy without moving. Upstream it is https://github.com/someone/else/pull/5.';

before(async () => {
  if (skip) return;
  host = await reviewHost(undefined, { agent: true, says: SAYS });
});

after(async () => {
  if (host) await host.stop();
});

for (const [name, options] of [
  ['desktop', { viewport: { width: 1280, height: 860 } }],
  ['phone', devices['iPhone 13']],
] as const) {
  test(`${name}: a pull request's link in an answer is a chip that opens its review; another repository's stays GitHub's`, { skip, timeout: 120_000 }, async () => {
    const { ctx, page, errors } = await host.open(options, host.agentUid!, 'dark');
    const answer = page.locator('.msg').filter({ hasText: 'The confirmation fix is up' }).last();
    const chip = answer.locator('a.pull-chip');
    await chip.waitFor({ timeout: 20_000 });
    assert.equal((await chip.textContent())?.trim(), 'proj#2');
    assert.equal(await chip.getAttribute('href'), 'https://github.com/me/proj/pull/2');
    // Not a repository this host works in: a plain link to GitHub.
    const other = answer.locator('a[href="https://github.com/someone/else/pull/5"]');
    assert.equal(await other.getAttribute('class'), null);
    assert.equal(await other.getAttribute('target'), '_blank');
    if (shots) await answer.screenshot({ path: join(shots, `${name}-answer.png`) });
    await chip.click();
    await until(async () => (await page.evaluate(() => location.hash)) === `#review/${host.stackId}/2`, 10_000, 'its review');
    await page.getByText('Add c').first().waitFor({ timeout: 20_000 });
    if (shots) await page.screenshot({ path: join(shots, `${name}-review.png`) });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`${name}: a pull request's link in the box is a chip too, opening its review`, { skip, timeout: 120_000 }, async () => {
    const { ctx, page, errors } = await host.open(options, host.agentUid!, 'dark');
    const box = page.locator('textarea').last();
    await box.waitFor({ timeout: 20_000 });
    const link = 'https://github.com/me/proj/pull/3';
    await box.fill(`Look at ${link}, and https://github.com/someone/else/pull/5 too`);
    const chips = page.locator('.mention-layer .mention-chip');
    await until(async () => (await chips.count()) === 1, 10_000, 'the chip');
    assert.equal(await chips.first().textContent(), link);
    if (shots) await page.locator('.mention-layer').screenshot({ path: join(shots, `${name}-box.png`) });
    await chips.first().click();
    await until(async () => (await page.evaluate(() => location.hash)) === `#review/${host.stackId}/3`, 10_000, 'its review');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

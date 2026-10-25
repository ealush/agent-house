// Paint the production materials over changing backdrops. Computed CSS alone
// cannot catch a decorative background layer painting over the filtered scene.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit, devices, type Browser, type Page } from 'playwright-core';

const chrome = [process.env.AH_CHROMIUM, '/usr/bin/chromium', '/usr/bin/google-chrome-stable'].find((p) => p && existsSync(p));
const wk = process.env.AH_GLASS_WEBKIT;
const skip = !chrome && !wk ? 'no test browser' : false;
const shots = process.env.AH_GLASS_SHOTS;
// Optional git ref provides a reproducible before/after material comparison.
const ref = process.env.AH_GLASS_CSS_REF;
const css = ['tokens.css', 'styles.css', 'site-theme.css'].map((p) => ref
  ? execFileSync('git', ['show', `${ref}:web/${p}`], { encoding: 'utf8' })
  : readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8')).join('\n');
let browser: Browser;

before(async () => {
  if (skip) return;
  browser = wk ? await webkit.launch({ executablePath: wk }) : await chromium.launch({ executablePath: chrome });
  if (shots) mkdirSync(shots, { recursive: true });
});
after(async () => { await browser?.close(); });

async function fixture(theme: string, contrast: 'no-preference' | 'more' = 'no-preference') {
  const context = await browser.newContext({ ...devices['iPhone 15 Pro'], deviceScaleFactor: 1, contrast });
  const page = await context.newPage();
  await page.setContent(`<html data-theme="${theme}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>
    .scene { position: relative; height: 100%; background: var(--test-backdrop, #d85532); }
    .sample { position: absolute; left: 40px; top: 40px; width: 280px; height: 160px; margin: 0; }
    .sample-label { position: absolute; left: 12px; top: 12px; font-size: 14px; }
  </style><body><div class="scene"><div class="nav-group sample"><span class="sample-label hint">Conversation controls</span></div></div></body></html>`);
  return { context, page, surface: page.locator('.sample') };
}

async function centerPixel(page: Page): Promise<number[]> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const surface = page.locator('.sample');
  const box = (await surface.boundingBox())!;
  const png = await page.screenshot({ animations: 'disabled' });
  // Decode the screenshot with the browser's image decoder; no image dependency.
  return page.evaluate(async ({ src, x, y }) => {
    const img = new Image(); img.src = src; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
  }, { src: `data:image/png;base64,${png.toString('base64')}`, x: box.x + 134, y: box.y + 74 });
}

for (const theme of ['light', 'dark']) {
  test(`${theme}: chrome transmits the real backdrop and blurs detail`, { skip, timeout: 30_000 }, async () => {
    const { context, page } = await fixture(theme);
    const red = await centerPixel(page);
    if (shots) await page.screenshot({ path: join(shots, `${theme}-red.png`) });
    await page.locator('.scene').evaluate((el) => el.style.setProperty('--test-backdrop', '#277ed0'));
    const blue = await centerPixel(page);
    const delta = Math.max(...red.map((c, i) => Math.abs(c - blue[i])));
    assert.ok(delta >= 35, `backdrop visibly changes the interior: ${red} → ${blue} (delta ${delta})`);
    if (shots) await page.screenshot({ path: join(shots, `${theme}-transmission.png`) });
    await page.locator('.scene').evaluate((el) => { el.style.background = 'repeating-linear-gradient(90deg, #000 0 4px, #fff 4px 8px)'; });
    assert.match(await page.locator('.sample').evaluate((el) => getComputedStyle(el).backdropFilter), /blur\(/);
    const filtered = await centerPixel(page);
    await page.locator('.sample').evaluate((el) => { el.style.setProperty('backdrop-filter', 'none'); el.style.setProperty('-webkit-backdrop-filter', 'none'); });
    const sharp = await centerPixel(page);
    assert.ok(Math.max(...filtered.map((c, i) => Math.abs(c - sharp[i]))) >= 15, `live blur changes painted detail: ${filtered} vs ${sharp}`);
    await context.close();
  });

  test(`${theme}: high contrast makes glass solid`, { skip, timeout: 30_000 }, async () => {
    const { context, page, surface } = await fixture(theme, 'more');
    assert.equal(await surface.evaluate((el) => getComputedStyle(el).backdropFilter), 'none');
    const red = await centerPixel(page);
    await page.locator('.scene').evaluate((el) => el.style.setProperty('--test-backdrop', '#277ed0'));
    assert.deepEqual(await centerPixel(page), red, 'the backdrop cannot alter the solid fallback');
    await context.close();
  });

  test(`${theme}: small glass labels read over black and white content`, { skip, timeout: 30_000 }, async () => {
    const { context, page } = await fixture(theme);
    const ink = await page.locator('.hint').evaluate((el) => getComputedStyle(el).color);
    const fg = await page.locator('.hint').evaluate((el) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = getComputedStyle(el).color; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
    const luminance = (rgb: number[]) => rgb.map((c) => c / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    for (const ground of ['#000', '#fff']) {
      await page.locator('.scene').evaluate((el, color) => el.style.setProperty('--test-backdrop', color), ground);
      const bg = await centerPixel(page);
      const levels = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      const contrast = (levels[0] + .05) / (levels[1] + .05);
      assert.ok(contrast >= 4.5, `${ink} on painted ${bg} is ${contrast.toFixed(2)}:1 over ${ground}`);
    }
    await context.close();
  });
}

test('sidebar filters its backing layer without trapping fixed menus', { skip, timeout: 30_000 }, async () => {
  const { context, page } = await fixture('dark');
  await page.locator('.sample').evaluate((el) => {
    el.className = 'sidebar sample';
    el.innerHTML = '<span>Sessions</span><div class="test-menu" style="position:fixed;top:300px;left:320px;width:32px;height:32px">Menu</div>';
  });
  const filter = await page.locator('.sidebar').evaluate((el) => ({ parent: getComputedStyle(el).backdropFilter, backing: getComputedStyle(el, '::before').backdropFilter }));
  assert.equal(filter.parent, 'none');
  assert.match(filter.backing, /blur\(/);
  const menu = (await page.locator('.test-menu').boundingBox())!;
  assert.ok(Math.abs(menu.x - 320) < 1 && Math.abs(menu.y - 300) < 1, `menu stays in viewport coordinates: ${JSON.stringify(menu)}`);
  const red = await centerPixel(page);
  await page.locator('.scene').evaluate((el) => el.style.setProperty('--test-backdrop', '#277ed0'));
  const blue = await centerPixel(page);
  assert.ok(Math.max(...red.map((c, i) => Math.abs(c - blue[i]))) >= 20, `sidebar transmits the scene: ${red} → ${blue}`);
  await context.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// One type ramp, one radius scale, four weights: the stylesheets may not drift
// back to 12.5px text or 9px corners. Fluid sizes (em, rem, clamp) are exempt.
const FILES = ['web/styles.css', 'web/site-theme.css', 'web/gui/gui.css', 'web/review/review.css'];
const TYPE = new Set([11, 12, 13, 14, 15, 16, 17, 20, 22, 24, 28]);
const RADIUS = new Set([0, 2, 4, 6, 8, 10, 12, 16, 999]);
const WEIGHT = new Set([400, 500, 600, 700]);

for (const file of FILES) {
  const css = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const lines = css.split('\n');
  const where = (re: RegExp, ok: (n: number) => boolean) =>
    lines.flatMap((l, i) => [...l.matchAll(re)].filter((m) => !ok(Number(m[1]))).map((m) => `${file}:${i + 1} ${m[0].trim()}`));

  test(`${file} stays on the type ramp`, () => {
    assert.deepEqual([...where(/font-size:\s*([0-9.]+)px/g, (n) => TYPE.has(n)), ...where(/font:\s*(?:\d{3}\s+)?([0-9.]+)px/g, (n) => TYPE.has(n))], []);
  });
  test(`${file} stays on the radius scale`, () => {
    const bad = lines.flatMap((l, i) => {
      const m = /border-radius:\s*([^;]+)/.exec(l);
      return m ? [...m[1].matchAll(/([0-9.]+)px/g)].filter((p) => !RADIUS.has(Number(p[1]))).map(() => `${file}:${i + 1} ${m[0]}`) : [];
    });
    assert.deepEqual(bad, []);
  });
  test(`${file} uses four weights`, () => {
    assert.deepEqual([...where(/font-weight:\s*(\d{3})/g, (n) => WEIGHT.has(n)), ...where(/font:\s*(\d{3})\s/g, (n) => WEIGHT.has(n))], []);
  });
}

// Secondary text (times, details, column heads, model names) is small, so it
// keeps WCAG AA's 4.5:1 on the grounds it sits on, in both themes.
test('muted and faint text read at 4.5:1 on the page and the sidebar', () => {
  const css = readFileSync(new URL('../web/site-theme.css', import.meta.url), 'utf8');
  const block = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));
  const token = (b: string, name: string) => /#[0-9a-f]{6}/i.exec(new RegExp(`--${name}:\\s*([^;]+);`).exec(b)?.[1] ?? '')?.[0];
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  for (const sel of [':root', ":root[data-theme='light']"]) {
    const b = block(sel);
    for (const fg of ['muted', 'faint'])
      for (const bg of ['bg', 'surface']) {
        const r = ratio(token(b, fg)!, token(b, bg)!);
        assert.ok(r >= 4.5, `${sel} --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }
  }
});

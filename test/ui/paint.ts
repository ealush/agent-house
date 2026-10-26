import type { Page } from 'playwright-core';

/** Read painted pixels in CSS coordinates, including Retina browser contexts. */
export async function readPixels(page: Page, points: { x: number; y: number }[]): Promise<number[][]> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const png = await page.screenshot({ animations: 'disabled' });
  return page.evaluate(async ({ src, points, width }) => {
    const img = new Image(); img.src = src; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
    const scale = img.width / width;
    return points.map(({ x, y }) => [...ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data].slice(0, 3));
  }, { src: `data:image/png;base64,${png.toString('base64')}`, points, width: page.viewportSize()!.width });
}

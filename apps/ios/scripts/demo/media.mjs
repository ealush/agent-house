// Attachments for the demo host's upload folder, made here so nothing binary is checked in:
// pictures (a dashboard, a phone screenshot, an error dialog), a short clip and a long screen
// recording (with ffmpeg, when it's installed), a PDF report and a log. The scripted agent's
// /media turn sends them as a message from you, as the app's composer would, plus a picture
// pasted straight into its terminal and a screenshot a tool took.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

// ---------- pictures: a canvas of RGBA pixels, a few shapes, PNG out

function canvas(width, height, [r, g, b]) {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < px.length; i += 4) px.set([r, g, b, 255], i);
  const rect = (x, y, w, h, [cr, cg, cb]) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) px.set([cr, cg, cb, 255], (yy * width + xx) * 4);
  };
  const dot = (cx, cy, radius, color) => {
    for (let yy = -radius; yy <= radius; yy++)
      for (let xx = -radius; xx <= radius; xx++) if (xx * xx + yy * yy <= radius * radius) rect(cx + xx, cy + yy, 1, 1, color);
  };
  const line = (x0, y0, x1, y1, weight, color) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= steps; i++) dot(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), weight, color);
  };
  const png = () => {
    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) px.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    const chunk = (type, data) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, 'ascii');
      const tail = Buffer.alloc(4);
      tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
      return Buffer.concat([head, data, tail]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  };
  return { rect, dot, line, png };
}

const INK = { ground: [25, 26, 37], card: [42, 44, 62], line: [62, 64, 84], pink: [244, 113, 153], cyan: [77, 217, 234], green: [129, 216, 138], amber: [245, 184, 75], white: [236, 236, 244] };

/** A latency dashboard: two cards of numbers, a p95 line that jumps at a deploy. */
function dashboard() {
  const c = canvas(1600, 1000, INK.ground);
  c.rect(0, 0, 1600, 84, INK.card);
  c.rect(40, 30, 220, 24, INK.white);
  for (let i = 0; i < 3; i++) {
    c.rect(40 + i * 520, 124, 480, 170, INK.card);
    c.rect(72 + i * 520, 156, 140, 18, INK.line);
    c.rect(72 + i * 520, 200, 260 - i * 50, 56, [INK.pink, INK.cyan, INK.green][i]);
  }
  c.rect(40, 334, 1520, 626, INK.card);
  for (let y = 0; y < 5; y++) c.rect(80, 400 + y * 110, 1440, 2, INK.line);
  let last = null;
  for (let x = 0; x <= 60; x++) {
    const value = x < 38 ? 120 + Math.sin(x / 3) * 18 : 330 + Math.sin(x / 2) * 30;
    const point = [80 + x * 24, 900 - value];
    if (last) c.line(last[0], last[1], point[0], point[1], 3, x < 38 ? INK.cyan : INK.pink);
    last = point;
  }
  c.rect(80 + 38 * 24, 380, 4, 540, INK.amber);
  return c.png();
}

/** A phone's screenshot: a tall list of rows, one of them failing. */
function phone() {
  const c = canvas(1179, 2556, [16, 17, 24]);
  c.rect(0, 0, 1179, 160, [16, 17, 24]);
  c.rect(60, 210, 420, 60, INK.white);
  for (let i = 0; i < 14; i++) {
    const y = 340 + i * 150;
    c.rect(48, y, 1083, 128, i === 5 ? [92, 32, 48] : INK.card);
    c.dot(120, y + 64, 30, i === 5 ? INK.pink : INK.green);
    c.rect(180, y + 34, 520 - (i % 4) * 60, 26, INK.white);
    c.rect(180, y + 76, 300, 18, INK.line);
  }
  return c.png();
}

/** An error dialog over a dimmed app. */
function dialog() {
  const c = canvas(1200, 800, [12, 12, 18]);
  for (let i = 0; i < 6; i++) c.rect(60, 60 + i * 110, 1080, 80, [30, 31, 44]);
  c.rect(300, 220, 600, 360, INK.card);
  c.dot(600, 320, 44, INK.pink);
  c.rect(588, 290, 24, 44, INK.white);
  c.rect(588, 342, 24, 14, INK.white);
  c.rect(400, 400, 400, 24, INK.white);
  c.rect(450, 444, 300, 18, INK.line);
  c.rect(340, 500, 520, 52, INK.pink);
  return c.png();
}

// ---------- a PDF report with a page of shapes and words (hand-written, offsets counted)

function report() {
  const page = [
    '0.11 0.12 0.18 rg 0 0 612 792 re f',
    '0.96 0.44 0.6 rg 48 700 220 6 re f',
    'BT /F1 28 Tf 0.95 0.95 0.97 rg 48 720 Td (Incident 2026-11-17) Tj ET',
    'BT /F1 14 Tf 0.79 0.79 0.83 rg 48 660 Td (Users API p95 rose from 120 ms to 340 ms after deploy 1.42.) Tj ET',
    'BT /F1 14 Tf 0.79 0.79 0.83 rg 48 636 Td (Cause: the users cache was bypassed for team lookups.) Tj ET',
    ...Array.from({ length: 8 }, (_, i) => `0.3 0.85 0.92 rg ${48 + i * 64} 380 40 ${60 + ((i * 37) % 180)} re f`),
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(page)} >>\nstream\n${page}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

function log() {
  return Array.from({ length: 400 }, (_, i) => {
    const ms = i < 240 ? 110 + (i % 17) : 320 + (i % 41);
    return `2026-11-17T09:${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z GET /users?team=${i % 9} ${ms}ms${ms > 300 ? ' cache=miss' : ' cache=hit'}`;
  }).join('\n') + '\n';
}

/** A clip of `seconds` with ffmpeg's test pattern; `noisy` makes it big (a screen recording's size). */
function clip(file, seconds, noisy) {
  const source = noisy ? `nullsrc=size=1280x720:rate=30:duration=${seconds},geq=random(1)*255:128:128` : `testsrc2=size=1280x720:rate=30:duration=${seconds}`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(noisy ? ['-b:v', '14M'] : ['-crf', '30']), '-movflags', '+faststart', file], { stdio: 'ignore' });
}

const STAMP = '2026-11-17T09-58-02-114Z-';

/** A recording left in the host's ~/Videos (made once, with ffmpeg): what the /recording turn links. Null without ffmpeg. */
export function demoRecording(home) {
  const file = join(home, 'Videos', 'agent-house-preview.mp4');
  if (existsSync(file)) return file;
  mkdirSync(join(home, 'Videos'), { recursive: true });
  try {
    clip(file, 15, false);
    return file;
  } catch {
    return null;
  }
}

/**
 * The upload folder's demo files (made once): their paths, in the order the /media message
 * sends them, and the pictures that go in inline.
 */
export function demoUploads(dir) {
  mkdirSync(dir, { recursive: true });
  const at = (name) => join(dir, STAMP + name);
  const made = [];
  const put = (name, make) => {
    const file = at(name);
    if (!existsSync(file)) writeFileSync(file, make());
    made.push(file);
  };
  put('latency-dashboard.png', dashboard);
  put('users-list.png', phone);
  let ffmpeg = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    ffmpeg = false;
  }
  if (ffmpeg) {
    for (const [name, seconds, noisy] of [['repro.mp4', 12, false], ['screen-recording.mov', 9, true]]) {
      const file = at(name);
      if (!existsSync(file)) {
        try {
          clip(file, seconds, noisy);
        } catch {
          continue;
        }
      }
      made.push(file);
    }
  }
  put('incident-report.pdf', report);
  put('users-api.log', log);
  const pasted = join(dir, '.demo-pasted.png');
  if (!existsSync(pasted)) writeFileSync(pasted, dialog());
  return { files: made, pasted: readFileSync(pasted).toString('base64') };
}

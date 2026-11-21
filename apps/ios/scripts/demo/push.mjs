#!/usr/bin/env node
// Writes the APNs payload ah would send for a demo session, built by ah's own
// `apnsPayload` (server/apns.ts), for `xcrun simctl push` (tour.sh's PUSH=). Demo use only.
//
//   node scripts/demo/push.mjs <demo state dir> <done|waiting|resolved> "<session title>" [--prompt <id>] > payload.json
//
// A waiting alert carries the session's current prompt id (`askId`), as ah sends it; `--prompt`
// puts another one in (an alert about an older prompt). `resolved` is the quiet push ah sends
// once that session stops waiting.
import { serverRoot } from '../server-root.mjs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dirArg, event, title] = process.argv.slice(2);
if (!['done', 'waiting', 'resolved'].includes(event) || !title) throw new Error('usage: push.mjs <dir> <done|waiting|resolved> "<session title>" [--prompt <id>]');
const promptArg = process.argv.indexOf('--prompt');
const source = serverRoot();
const { apnsPayload, resolvedPayload } = await import(pathToFileURL(join(source, 'server/apns.ts')).href);
const { port, localToken } = JSON.parse(readFileSync(join(resolve(dirArg), 'demo.json'), 'utf8'));
const res = await fetch(`http://localhost:${port}/api/state`, { headers: { Authorization: `Bearer ${localToken}`, 'X-AH': '1' } });
if (!res.ok) throw new Error(`state: ${res.status}`);
const state = await res.json();
const w = state.windows.find((w) => w.title === title);
if (!w) throw new Error(`no session titled ${title}`);
const alert = {
  title: event === 'done' ? `${w.title} finished` : `${w.title} needs you`,
  body: [w.project, w.detail].filter(Boolean).join(' · '),
  tag: w.uid, route: w.uid, host: state.hostname,
  badge: state.windows.filter((x) => x.status === 'waiting').length,
  answerable: event === 'waiting' && w.answerable,
  prompt: promptArg > 0 ? process.argv[promptArg + 1] : w.askId,
};
const payload = event === 'resolved' ? resolvedPayload({ route: w.uid, host: state.hostname, tag: w.uid, waiting: alert.badge }) : apnsPayload(alert, event, 'full');
process.stdout.write(JSON.stringify({ 'Simulator Target Bundle': 'dev.ealush.ah.native', ...payload }, null, 2) + '\n');

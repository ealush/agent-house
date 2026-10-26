#!/usr/bin/env node
// Every route the ah server answers, and the native client call that reaches it. The rule
// (docs/native/DECISIONS.md): nothing the backend can do is unreachable from the app, unless
// a reason below says why the app reaches it another way.
//
//   AH_SOURCE=../ah node scripts/backend-coverage.mjs             # exits 1 on an uncovered route
//   AH_SOURCE=../ah node scripts/backend-coverage.mjs --markdown  # the map, for the docs
//
// It reads both sources as text: routes from server/main.ts and server/review/api.ts, calls
// from the client's request lines (a method, then a path literal or a path helper).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const source = resolve(process.env.AH_SOURCE ?? join(root, '../ah'));
const read = (p) => readFileSync(p, 'utf8');

// Routes the app reaches another way, or may not call at all.
const ELSEWHERE = {
  'GET /api/push/key': 'Web Push (VAPID) is for browsers; the app gets notifications through APNs (`/api/push/apns`).',
  'POST /api/push/subscribe': 'Web Push is for browsers; the app gets notifications through APNs (`/api/push/apns`).',
  'POST /api/push/unsubscribe': 'Web Push is for browsers; the app gets notifications through APNs (`/api/push/apns`).',
  'POST /api/push/status': 'Web Push is for browsers; the app gets notifications through APNs (`/api/push/apns`).',
  'POST /api/auth/register/options': 'Passkeys are how browsers sign in; the app enrolls a device key (`/api/auth/native/enroll/…`).',
  'POST /api/auth/register/verify': 'Passkeys are how browsers sign in; the app signs in with its device key (`/api/auth/native/…`).',
  'POST /api/auth/login/options': 'Passkeys are how browsers sign in; the app signs in with its device key (`/api/auth/native/login/…`).',
  'POST /api/auth/login/verify': 'Passkeys are how browsers sign in; the app signs in with its device key (`/api/auth/native/…`).',
  'POST /api/auth/password/login': 'Password sign-in is for browsers; the app signs in with its device key.',
  'POST /api/auth/password': 'The server takes the master password only from the host itself (`ah auth password`); the app shows whether one is set.',
};

// ---------- routes

const routes = [];
const main = read(join(source, 'server/main.ts'));
for (const m of main.matchAll(/route\('(GET|POST|PUT|PATCH|DELETE)', \/(.+?)\/\)/g)) routes.push({ method: m[1], re: new RegExp(m[2]) });
// A session's window routes, by uid (main.ts resolves /api/sessions/<uid>/<what> to its window).
const alias = main.match(/\/\^\\\/api\\\/sessions\\\/\(\[\\w-\]\{1,40\}\)\\\/\(([^)]+)\)\$\//);
if (!alias) throw new Error('main.ts: the session alias for window routes moved; update this script');
const aliased = alias[1].replace(/\\\//g, '/').split('|');
const windowRoutes = routes.filter((r) => r.re.source.startsWith('^\\/api\\/windows\\/(@\\d+)\\/') || r.re.source.startsWith('^/api/windows/(@\\d+)/'));
for (const what of aliased) {
  const verbs = what === 'name' ? ['PUT'] : what === 'terminate' ? ['POST'] : what === 'capture' ? ['GET'] : windowRoutes.filter((r) => r.re.test(`/api/windows/@1/${what}`)).map((r) => r.method);
  for (const method of verbs) routes.push({ method, re: new RegExp(`^/api/sessions/([\\w-]{1,40})/${what}$`), via: 'session alias' });
}
// The window routes themselves are what the aliases reach; the app always goes by uid.
const byUid = (r) => /^\^\\?\/api\\?\/windows/.test(r.re.source);
const review = read(join(source, 'server/review/api.ts'));
const ID = '([\\w-]{4,40})';
const PR = '(\\d{1,7})';
for (const m of review.matchAll(/route\('(GET|POST|PUT|PATCH|DELETE)', (?:'([^']*)'|`([^`]*)`)/g)) {
  const path = (m[2] ?? m[3]).replaceAll('${ID}', ID).replaceAll('${PR}', PR).replaceAll('\\\\', '\\');
  routes.push({ method: m[1], re: new RegExp(`^/api/review${path}$`) });
}
routes.push({ method: 'GET', re: /^\/ws\/(@\d+)$/, via: 'WebSocket upgrade' });

// ---------- the client's calls

const swift = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.swift')) swift.push(p);
  }
};
walk(join(root, 'Sources'));
const PREFIX = {
  'APIClient.swift': { s: '/api/sessions/abcd7' },
  'ReviewAPI.swift': { s: '/api/review/stacks/abcd7', l: '/api/review/stacks/abcd7/layers/7' },
};
/** The text of a call's next argument: up to a comma or `)` outside quotes and parentheses. */
function firstArgument(rest) {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quoted) {
      if (c === '\\' && rest[i + 1] === '(') {
        // An interpolation: skip to its closing parenthesis.
        let d = 0;
        for (i++; i < rest.length; i++) {
          if (rest[i] === '(') d++;
          else if (rest[i] === ')' && --d === 0) break;
        }
      } else if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '(') depth++;
    else if (c === ')' && depth-- === 0) return rest.slice(0, i).trim();
    else if (c === ',' && depth === 0) return rest.slice(0, i).trim();
  }
  return rest.trim();
}

const calls = [];
for (const file of swift) {
  const text = read(file);
  const helpers = PREFIX[file.split('/').pop()] ?? {};
  let fn = null;
  for (const line of text.split('\n')) {
    const f = line.match(/func (\w+)\(/);
    if (f) fn = f[1];
    const expand = (expr) =>
      expr
        .replace(/\\\(l\([^)]*\)\)/g, helpers.l ?? '7')
        .replace(/\\\(s\([^)]*\)\)/g, helpers.s ?? '7')
        .replace(/\\\([^)]*\)+/g, '\u0000');
    for (const m of line.matchAll(/"(GET|POST|PUT|PATCH|DELETE)", */g)) {
      const arg = firstArgument(line.slice(m.index + m[0].length));
      const paths = [];
      for (const lit of arg.matchAll(/"((?:[^"\\]|\\\([^)]*\)+|\\.)*)"/g)) paths.push(expand(lit[1]));
      const helper = arg.match(/^(s|l)\(/);
      if (!paths.length && helper && helpers[helper[1]]) paths.push(helpers[helper[1]]);
      // An interpolated id may need to be a number or a name: try both.
      for (const path of paths) for (const v of ['7', 'a7']) calls.push({ method: m[1], path: path.split('?')[0].replaceAll('\u0000', v), fn, file: relative(root, file) });
    }
    for (const m of line.matchAll(/eventStream\("((?:[^"\\]|\\\([^)]*\)+)*)"/g)) calls.push({ method: 'GET', path: expand(m[1]).replaceAll('\u0000', '7'), fn, file: relative(root, file) });
    if (/url\("\/ws\//.test(line)) calls.push({ method: 'GET', path: '/ws/@7', fn, file: relative(root, file) });
  }
}

// ---------- match

const key = (r) => `${r.method} ${r.re.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/')}`;
const rows = routes.map((r) => {
  const hits = calls.filter((c) => c.method === r.method && r.re.test(c.path));
  const k = key(r);
  // Each route counts once: a client call, else reached by session uid, else a stated reason.
  return { route: k, via: r.via, calls: hits, byWindow: !hits.length && byUid(r), elsewhere: !hits.length && !byUid(r) ? ELSEWHERE[k] : undefined };
});
const uncovered = rows.filter((r) => !r.calls.length && !r.elsewhere && !r.byWindow);

if (process.argv.includes('--markdown')) {
  const cell = (s) => s.replaceAll('|', '\\|');
  const out = [
    '# Backend coverage',
    '',
    'Every route the ah server answers, and how the app reaches it. Generated by `scripts/backend-coverage.mjs` from `../ah` (`server/main.ts`, `server/review/api.ts`) and this repo\'s client; `scripts/integration.sh` fails when a route has neither a client call nor a reason here.',
    '',
    `${rows.filter((r) => r.calls.length).length} of ${rows.length} routes have a client call; ${rows.filter((r) => r.byWindow).length} are window routes the app reaches by session uid; ${rows.filter((r) => r.elsewhere).length} are reached another way.`,
    '',
    '| Route | Client |',
    '| --- | --- |',
  ];
  for (const r of rows.sort((a, b) => a.route.split(' ')[1].localeCompare(b.route.split(' ')[1]) || a.route.localeCompare(b.route))) {
    const how = r.calls.length
      ? [...new Set(r.calls.map((c) => `\`${c.fn}\` (${c.file.split('/').pop()})`))].join(', ')
      : r.byWindow
        ? 'By session uid (`/api/sessions/<uid>/…`)'
        : r.elsewhere ?? '**none**';
    out.push(`| \`${cell(r.route)}\`${r.via ? ` (${r.via})` : ''} | ${cell(how)} |`);
  }
  process.stdout.write(out.join('\n') + '\n');
} else {
  for (const r of uncovered) process.stdout.write(`no native path: ${r.route}\n`);
  process.stdout.write(`${rows.length} routes; ${rows.length - uncovered.length} reachable from the app or covered by a stated reason; ${uncovered.length} not\n`);
  process.exit(uncovered.length ? 1 : 0);
}

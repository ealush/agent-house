#!/usr/bin/env node
// Every route the ah server answers, and the native client call that reaches it. The rule
// (docs/native/DECISIONS.md): nothing the backend can do is unreachable from the app, unless
// a reason below says why the app reaches it another way.
//
//   node scripts/backend-coverage.mjs             # exits 1 on an uncovered route
//   node scripts/backend-coverage.mjs --markdown  # the map, for the docs
//
// The server is this repository's own (AH_SOURCE=<checkout> reads another).
//
// It reads both sources as text: routes from the server's route tables (server/api/*.ts,
// main.ts) and its routers mounted by prefix (review, portable, migrations, jobs, notes), calls
// from the client's request lines (a method, then a path literal or a path helper).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { serverRoot } from './server-root.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const source = serverRoot();
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
  'GET /api/capabilities': 'The app reads the same feature map from `/api/hello` and state `features`; an upload over the limit is refused by the host and said so.',
  'GET /api/notes/([0-9a-fA-F-]{36})': 'Notes sync by `GET /api/notes?since=`, and a refused write carries the host\'s note (409): the app never fetches one note alone.',
  'GET /api/notes/handoffs/([\\w-]{8,40})': 'A hand-off\'s POST answers with its outcome; asking again sends the same id, which the ledger replays.',
  'GET /api/portable/operations': 'The app follows the continuation it started (`GET /api/portable/operations/:id`); Conversation Lineage shows the rest.',
  'GET /api/portable/conversations/([\\w:.-]{1,80})': 'The portable document itself is the host\'s (a download for people); the app shows the preview and the lineage instead.',
};
// Host to host: the host a session moves from calls these on the one it moves to.
for (const r of ['POST /api/migrations/incoming/preflight', 'POST /api/migrations/incoming', 'PUT /api/migrations/incoming/(mg-[0-9a-f]{8})/files/(transcript|doc|att-\\d{1,3}|ldoc-lk-[0-9a-f]{8})', 'POST /api/migrations/incoming/(mg-[0-9a-f]{8})/commit', 'POST /api/migrations/incoming/(mg-[0-9a-f]{8})/verify', 'DELETE /api/migrations/incoming/(mg-[0-9a-f]{8})'])
  ELSEWHERE[r] = 'Host to host: the host a session moves from calls this on the host it moves to (`server/migrate`); no client does.';

// Routes the app has no path to yet, each named with what it waits for. They're listed in the
// map as gaps (docs/native/PARITY.md tracks them) and don't fail the check; a route with
// neither a call, a reason nor an entry here does.
const PENDING = {
  'GET /api/interruptions': 'Interrupted sessions in the Inbox (Restore all / Restore / Dismiss).',
  'POST /api/interruptions/(restore|dismiss)': 'Interrupted sessions in the Inbox (Restore all / Restore / Dismiss).',
  'POST /api/sessions/([\\w-]{1,40})/restore': 'Restore an interrupted session from History.',
  'GET /api/recovery': 'Recovery from limits and crashes: the session header and its menu.',
  'GET /api/sessions/([\\w-]{1,40})/recovery': 'Recovery from limits and crashes: the session header and its menu.',
  'POST /api/sessions/([\\w-]{1,40})/recovery': 'Recovery from limits and crashes: the session header and its menu.',
  'GET /api/migrations': 'Move a session to another host.',
  'GET /api/migrations/(mg-[0-9a-f]{8})': 'Move a session to another host.',
  'POST /api/migrations/preview': 'Move a session to another host.',
  'POST /api/migrations': 'Move a session to another host.',
  'POST /api/migrations/(mg-[0-9a-f]{8})/retry': 'Move a session to another host.',
  'POST /api/migrations/(mg-[0-9a-f]{8})/cancel': 'Move a session to another host.',
  'GET /api/system/logging': 'Settings → System → Developer: the host\'s log and the app\'s log bundle.',
  'PUT /api/system/logging': 'Settings → System → Developer: the host\'s log and the app\'s log bundle.',
  'POST /api/system/logging/client': 'Settings → System → Developer: the host\'s log and the app\'s log bundle.',
};

// ---------- routes

const routes = [];
// Route tables (server/api/*.ts, and main.ts for what's left there): `route('GET', /^…$/, …)`.
const tables = ['server/main.ts', ...readdirSync(join(source, 'server/api')).filter((f) => f.endsWith('.ts')).map((f) => `server/api/${f}`)];
for (const file of tables) {
  for (const m of read(join(source, file)).matchAll(/(?:route|publicRoute)\('(GET|POST|PUT|PATCH|DELETE)', \/((?:\\.|\[(?:\\.|[^\]\n])*\]|[^\/\n\[])+)\/[,)]/g)) routes.push({ method: m[1], re: new RegExp(m[2]) });
}
// Answered in main.ts before the tables, by path.
routes.push({ method: 'GET', re: /^\/api\/hello$/ });
const main = read(join(source, 'server/main.ts'));
// A session's window routes, by uid (main.ts resolves /api/sessions/<uid>/<what> to its window).
const alias = main.match(/\/\^\\\/api\\\/sessions\\\/\(\[\\w-\]\{1,40\}\)\\\/\(([^)]+)\)\$\//);
if (!alias) throw new Error('main.ts: the session alias for window routes moved; update this script');
const aliased = alias[1].replace(/\\\//g, '/').split('|');
const windowRoutes = routes.filter((r) => r.re.source.startsWith('^\\/api\\/windows\\/(@\\d+)') || r.re.source.startsWith('^/api/windows/(@\\d+)'));
for (const what of aliased) {
  const verbs = what === 'name' ? ['PUT'] : what === 'terminate' ? ['POST'] : windowRoutes.filter((r) => r.re.test(`/api/windows/@1/${what}`)).map((r) => r.method);
  for (const method of verbs) routes.push({ method, re: new RegExp(`^/api/sessions/([\\w-]{1,40})/${what}$`), via: 'session alias' });
}
// The window routes themselves are what the aliases reach; the app always goes by uid.
const byUid = (r) => /^\^\\?\/api\\?\/windows/.test(r.re.source);
// Routers mounted by prefix (review, portable, migrations, jobs, notes): `route('GET', `/${ID}`)`
// under `new RegExp(`^/api/<prefix>${re}$`)`, their ids named by `const ID = '(…)'`.
const walkTs = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
};
for (const file of walkTs(join(source, 'server'))) {
  const text = read(file);
  const mount = text.match(/new RegExp\(`\^(\/api\/[\w/-]+)\$\{re\}\$`\)/);
  if (!mount) continue;
  const names = Object.fromEntries([...text.matchAll(/^const ([A-Z]+) = '([^']*)';/gm)].map((m) => [m[1], m[2]]));
  for (const m of text.matchAll(/route\('(GET|POST|PUT|PATCH|DELETE)', (?:'([^']*)'|`([^`]*)`)/g)) {
    const path = (m[2] ?? m[3]).replace(/\$\{([A-Z]+)\}/g, (_, n) => names[n] ?? '([^/]+)').replaceAll('\\\\', '\\');
    routes.push({ method: m[1], re: new RegExp(`^${mount[1]}${path}$`) });
  }
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

const IDS = ['7', 'a7', '0000abcd-0000-4000-8000-00000000abcd', 'jb-0000abcd', 'jr-0000abcd', 'lk-0000abcd', 'mg-0000abcd', 'ck-0000abcd'];
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
      // An interpolated id may need to be a number, a name, a UUID or a prefixed id: try each.
      for (const path of paths) for (const v of IDS) calls.push({ method: m[1], path: path.split('?')[0].replaceAll('\u0000', v), fn, file: relative(root, file) });
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
  const elsewhere = !hits.length && !byUid(r) ? ELSEWHERE[k] : undefined;
  return { route: k, via: r.via, calls: hits, byWindow: !hits.length && byUid(r), elsewhere, pending: !hits.length && !byUid(r) && !elsewhere ? PENDING[k] : undefined };
});
const uncovered = rows.filter((r) => !r.calls.length && !r.elsewhere && !r.byWindow && !r.pending);
const pending = rows.filter((r) => r.pending);
// A pending entry for a route the app now calls (or that's gone) is stale: say so.
const stale = Object.keys(PENDING).filter((k) => !pending.some((r) => r.route === k));

if (process.argv.includes('--markdown')) {
  const cell = (s) => s.replaceAll('|', '\\|');
  const out = [
    '# Backend coverage',
    '',
    'Every route the ah server answers, and how the app reaches it. Generated by `scripts/backend-coverage.mjs` from the server (`server/api/*.ts`, `server/main.ts`, and the routers mounted by prefix: review, portable, migrations, jobs, notes) and this repo\'s client; `scripts/integration.sh` fails when a route has neither a client call, a reason, nor a **not yet** entry naming what it waits for.',
    '',
    `${rows.filter((r) => r.calls.length).length} of ${rows.length} routes have a client call; ${rows.filter((r) => r.byWindow).length} are window routes the app reaches by session uid; ${rows.filter((r) => r.elsewhere).length} are reached another way; ${pending.length} have no native path yet (**not yet**).`,
    '',
    '| Route | Client |',
    '| --- | --- |',
  ];
  for (const r of rows.sort((a, b) => a.route.split(' ')[1].localeCompare(b.route.split(' ')[1]) || a.route.localeCompare(b.route))) {
    const how = r.calls.length
      ? [...new Set(r.calls.map((c) => `\`${c.fn}\` (${c.file.split('/').pop()})`))].join(', ')
      : r.byWindow
        ? 'By session uid (`/api/sessions/<uid>/…`)'
        : r.elsewhere ?? (r.pending ? `**not yet**: ${r.pending}` : '**none**');
    out.push(`| \`${cell(r.route)}\`${r.via ? ` (${r.via})` : ''} | ${cell(how)} |`);
  }
  process.stdout.write(out.join('\n') + '\n');
} else {
  for (const r of pending) process.stdout.write(`not yet: ${r.route} (${r.pending})\n`);
  for (const k of stale) process.stdout.write(`stale pending entry (the app calls it now, or the host has no such route): ${k}\n`);
  for (const r of uncovered) process.stdout.write(`no native path: ${r.route}\n`);
  process.stdout.write(`${rows.length} routes; ${rows.length - uncovered.length - pending.length} reachable from the app or covered by a stated reason; ${pending.length} not yet; ${uncovered.length} not\n`);
  process.exit(uncovered.length || stale.length ? 1 : 0);
}
